# legacy-ui (reference only)

These are Tailwind/lucide React components from the old Real-Chat-WebApp, kept as a **visual reference** for porting the layout into `web/`. They are:

- **not built, linted, type-checked or imported.** They are excluded in `eslint.config.js`; nothing in `web/` may import from here.
- **not working code.** They depend on the deleted `SocketContext`, `AuthContext` and `ThemeContext`, and contain mock data (`UserProfile.jsx`) and stubs. `docs/AUDIT.md` §1.7 lists what was fake.
- **not the Chitthi look.** The green bubbles and green accents imitate WhatsApp. Port the structure and spacing, never the colours or branding. Chitthi's palette lives in `web/src/index.css`.

Changes made when archiving:
- "WhatsApp Clone" text was replaced with "Chitthi".
- The false end-to-end-encryption claim was corrected.
- The voice/video call buttons were removed (calls are a non-goal).

The full original code is in the offline backup `E:\Dhruv\_backups\realchat-legacy-2026-10-19.zip`.
