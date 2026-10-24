import type { ReactNode } from 'react';
import { Link } from 'react-router';

// The public privacy policy and terms (/privacy, /terms): linked from sign-in, Settings and
// Google's consent screen. Plain words, and only what the code really does: each statement
// below has a source in api/, db/migrations/ or docs/MAINTENANCE.md. Change them together.
export const CONTACT_EMAIL = 'privacy@dhruvgoyal.tech';
const UPDATED = '24 October 2026';

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-full justify-center p-4">
      <article className="letter w-full max-w-2xl space-y-4 rounded-sm p-6 text-ink shadow-sm [&_h2]:mt-6 [&_h2]:font-[family-name:var(--font-letter)] [&_h2]:text-lg [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1">
        <p><Link to="/" className="text-sm text-ink-soft underline underline-offset-2">← Chitthi</Link></p>
        <h1 className="font-[family-name:var(--font-letter)] text-2xl">{title}</h1>
        <p className="text-sm text-ink-soft">Last updated {UPDATED}</p>
        {children}
        <p className="border-t border-dashed border-paper-edge pt-4 text-sm">
          Questions or requests: <a href={`mailto:${CONTACT_EMAIL}`} className="underline underline-offset-2">{CONTACT_EMAIL}</a>
          {' · '}<Link to="/privacy" className="underline underline-offset-2">Privacy</Link>
          {' · '}<Link to="/terms" className="underline underline-offset-2">Terms</Link>
        </p>
      </article>
    </main>
  );
}

export function Privacy() {
  return (
    <Page title="Privacy">
      <p>
        Chitthi is a chat app run as a personal project by Dhruv Goyal. This page says what it keeps about you,
        where, for how long, and how to remove it.
      </p>

      <h2>Not end-to-end encrypted</h2>
      <p>
        Messages and files are encrypted on their way between your device and the server (HTTPS), and backups are
        encrypted. On the server they are stored as they are: <strong>the server, and anyone with access to its
        database, can read every message.</strong> We don&apos;t read your messages, but nothing technical stops it.
        Don&apos;t use Chitthi for anything you couldn&apos;t accept someone else reading.
      </p>

      <h2>What we keep</h2>
      <ul>
        <li><strong>Your account:</strong> your handle, display name, profile picture link and when you joined.</li>
        <li>
          <strong>From Google or GitHub, when you sign in:</strong> your account id there, your verified email address, your
          name and picture link. We ask Google for <em>openid, email, profile</em> and GitHub for <em>read:user,
          user:email</em>. We never see your password, we post nothing anywhere, and the access token is dropped
          as soon as sign-in finishes.
        </li>
        <li>
          <strong>Your messages:</strong> the text, when it was sent, edited or deleted, and who it went to. An edit keeps only
          the new text (plus a fingerprint of the first version, used to recognise a retried send).
        </li>
        <li>
          <strong>Files and photos you send:</strong> the file, its name, type, size and a fingerprint. Photos are re-encoded
          before they are stored, which removes location and camera data, and get a small thumbnail.
        </li>
        <li><strong>Receipts:</strong> when your messages were delivered to and read by each person, and the same for messages to you.</li>
        <li><strong>Conversations:</strong> who is in each one and when they joined or left, and who you have blocked.</li>
        <li>
          <strong>Sign-in sessions:</strong> a scrambled (hashed) form of your session key, your browser&apos;s name and version,
          and when the session started, was last used and expires (after 7 days).
        </li>
        <li><strong>Limits:</strong> short-lived counters, by IP address or account, that stop floods of sign-ins, messages and uploads.</li>
        <li>
          <strong>Server logs:</strong> each request&apos;s time, address (URL), IP address and browser, with cookies removed. They
          stay on the server in rotating files of limited size (days to a few weeks, depending on traffic) and are not backed up.
        </li>
      </ul>
      <p>
        Who is online and who is typing exist only in the server&apos;s memory and are never stored. There are no ads, no analytics
        and no third-party trackers. Chitthi sets only the cookies it needs: your session cookie, and two short-lived ones during sign-in.
      </p>

      <h2>Where it is, and who handles it</h2>
      <ul>
        <li><strong>Microsoft Azure, Malaysia West:</strong> the server, the database, your files and the main encrypted backups.</li>
        <li><strong>Cloudflare R2 (Asia-Pacific):</strong> a second, encrypted copy of the backups.</li>
        <li><strong>Google and GitHub:</strong> only to sign you in, as described above.</li>
      </ul>
      <p>Nobody else gets your data. We don&apos;t sell it, share it or use it to advertise.</p>

      <h2>Who can see what</h2>
      <p>
        The people in a conversation see its messages and files from when they joined until they left. Others see your
        handle, display name and picture when they search for you or share a conversation with you. Files can only be
        downloaded by members of the conversation they were sent in.
      </p>

      <h2>Deleting things</h2>
      <ul>
        <li>
          <strong>Delete a message for everyone:</strong> its text is erased and its files are removed from the server at once.
          The chat shows that a message was deleted there.
        </li>
        <li>
          <strong>Delete your account</strong> (Settings → Account): your sessions, sign-in links, blocks and profile details are
          removed, and you leave every group. Your messages stay in other people&apos;s chats under &ldquo;Deleted user&rdquo;, unless you
          also choose to erase them, which erases their text and files. Your handle is held for 30 days so nobody can pose as you.
          Signing in again later starts a new account.
        </li>
        <li>
          <strong>Backups:</strong> every night an encrypted copy of the database and new files is made. Database copies are
          deleted after 35 days, then kept up to 14 more days in the storage&apos;s recycle bin: about 7 weeks in all. Files can
          last up to about 12 weeks in backups. Until then, something you deleted can still be in a backup. Backups are only
          used to recover from a failure, never to bring back something you deleted.
        </li>
      </ul>

      <h2>Your choices</h2>
      <p>
        You can change your name and handle, delete messages and delete your account yourself. For anything else, such as a
        copy of your data or a question about this page, email {CONTACT_EMAIL}.
      </p>

      <h2>Children</h2>
      <p>Chitthi is not for children under 13.</p>

      <h2>Changes</h2>
      <p>If this page changes, the new version is posted here with a new date.</p>
    </Page>
  );
}

export function Terms() {
  return (
    <Page title="Terms">
      <p>
        Chitthi is a free chat app run as a personal project by Dhruv Goyal. By using it you agree to these terms. They are
        short on purpose.
      </p>

      <h2>The service</h2>
      <ul>
        <li>Chitthi is provided as it is, free, with no promise that it will always be available, keep every message, or keep running.</li>
        <li>It may change or close. If it is going to close, a notice will be posted on this site first.</li>
        <li>
          <strong>Messages are not end-to-end encrypted:</strong> the server can read them. See <Link to="/privacy" className="underline underline-offset-2">Privacy</Link>.
        </li>
      </ul>

      <h2>Your account</h2>
      <ul>
        <li>You must be at least 13, or older if your country requires it.</li>
        <li>You sign in with Google or GitHub. Keep that account secure: whoever controls it controls your Chitthi account.</li>
        <li>Pick a handle and name that don&apos;t pretend to be someone else.</li>
      </ul>

      <h2>What you send</h2>
      <ul>
        <li>What you write and share stays yours. You let Chitthi store it, deliver it to the people you send it to, and keep it in backups as described in Privacy.</li>
        <li>
          Don&apos;t use Chitthi to break the law, harass or threaten anyone, send spam, share malware, share someone&apos;s private
          information without their consent, or try to break, overload or get around the limits of the service.
        </li>
        <li>Uploads have limits: photos up to 10 MB and other files up to 25 MB, up to 10 per message, and up to 200 MB or 100 uploads a day.</li>
      </ul>

      <h2>When things go wrong</h2>
      <ul>
        <li>Accounts or content that break these terms may be removed, with or without notice.</li>
        <li>To the extent the law allows, Chitthi and its operator are not liable for lost messages, downtime or anything that results from using it.</li>
        <li>You can stop using Chitthi and delete your account at any time.</li>
      </ul>

      <h2>Changes</h2>
      <p>If these terms change, the new version is posted here with a new date. Using Chitthi after that means you accept it.</p>
    </Page>
  );
}
