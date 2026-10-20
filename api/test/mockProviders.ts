import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

type Started = { url: string; close: () => Promise<void> };

async function listen(handler: (req: IncomingMessage, body: string) => Promise<{ status?: number; json: unknown }>): Promise<Started & { server: Server }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      handler(req, body).then(
        ({ status = 200, json }) => { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json)); },
        (err: unknown) => { res.writeHead(500).end(String(err)); },
      );
    });
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const addr = server.address();
  const url = `http://127.0.0.1:${String(typeof addr === 'object' && addr ? addr.port : 0)}`;
  return { server, url, close: () => new Promise<void>((r) => { server.close(() => { r(); }); }) };
}

const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export type GoogleScenario = {
  claims?: Partial<JWTPayload> & Record<string, unknown>;
  /** Sign with a key that is not in the JWKS. */
  foreignKey?: boolean;
  tokenStatus?: number;
};

/**
 * A Google stand-in: JWKS, and a token endpoint that checks the PKCE verifier against the
 * challenge of the flow and returns an RS256 ID token shaped by the current scenario.
 */
export async function mockGoogle(clientId: string) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const kid = randomUUID();
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const state = { challenge: '', nonce: '', scenario: {} as GoogleScenario, subject: randomUUID(), email: 'a@example.com', lastVerifierOk: false };
  const started = await listen(async (req, body) => {
    if (req.url === '/jwks') return { json: { keys: [jwk] } };
    if (req.url === '/token') {
      const form = new URLSearchParams(body);
      state.lastVerifierOk = challengeOf(form.get('code_verifier') ?? '') === state.challenge;
      if (!state.lastVerifierOk) return { status: 400, json: { error: 'invalid_grant' } };
      if (state.scenario.tokenStatus) return { status: state.scenario.tokenStatus, json: { error: 'server_error' } };
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: started.url, aud: clientId, sub: state.subject, email: state.email, email_verified: true,
        name: 'Asha Rao', picture: 'https://lh3.example.com/a.png', nonce: state.nonce, iat: now, exp: now + 300,
        ...state.scenario.claims,
      };
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid })
        .sign(state.scenario.foreignKey ? foreign.privateKey : privateKey);
      return { json: { id_token: token, access_token: 'unused', token_type: 'Bearer' } };
    }
    return { status: 404, json: {} };
  });
  return {
    ...started,
    state,
    /** Remembers the challenge and nonce of the flow the API just started (from its redirect). */
    expectFlow(authorizeUrl: string) {
      const u = new URL(authorizeUrl);
      state.challenge = u.searchParams.get('code_challenge') ?? '';
      state.nonce = u.searchParams.get('nonce') ?? '';
    },
  };
}

export type GithubScenario = { emails?: unknown[]; tokenStatus?: number; userStatus?: number };

/** A GitHub stand-in: token (PKCE-checked), /user and /user/emails. */
export async function mockGithub() {
  const state = { challenge: '', scenario: {} as GithubScenario, id: Math.floor(Math.random() * 1e9), email: 'b@example.com', lastVerifierOk: false };
  const started = await listen((req, body) => {
    if (req.url === '/token') {
      const json = JSON.parse(body || '{}') as { code_verifier?: string };
      state.lastVerifierOk = challengeOf(json.code_verifier ?? '') === state.challenge;
      if (!state.lastVerifierOk || state.scenario.tokenStatus) return Promise.resolve({ status: state.scenario.tokenStatus ?? 400, json: { error: 'bad_verification_code' } });
      return Promise.resolve({ json: { access_token: 'gho_test', token_type: 'bearer' } });
    }
    if (req.headers.authorization !== 'Bearer gho_test') return Promise.resolve({ status: 401, json: {} });
    if (req.url === '/user') {
      return Promise.resolve(state.scenario.userStatus
        ? { status: state.scenario.userStatus, json: {} }
        : { json: { id: state.id, login: 'ravi-k', name: 'Ravi Kumar', avatar_url: 'https://avatars.example.com/u/1' } });
    }
    if (req.url === '/user/emails') {
      return Promise.resolve({ json: state.scenario.emails ?? [
        { email: 'old@example.com', primary: false, verified: true },
        { email: state.email, primary: true, verified: true },
      ] });
    }
    return Promise.resolve({ status: 404, json: {} });
  });
  return {
    ...started,
    state,
    expectFlow(authorizeUrl: string) {
      state.challenge = new URL(authorizeUrl).searchParams.get('code_challenge') ?? '';
    },
  };
}
