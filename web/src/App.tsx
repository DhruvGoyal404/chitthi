import { Navigate, Route, Routes } from 'react-router';
import { Chat } from './screens/Chat.js';
import { ConversationInfo } from './screens/ConversationInfo.js';
import { NewChat } from './screens/NewChat.js';
import { NewGroup } from './screens/NewGroup.js';
import { Settings } from './screens/Settings.js';
import { Shell } from './screens/Shell.js';
import { SignIn } from './screens/SignIn.js';
import { useMe } from './session.js';

function SignInRoute() {
  const me = useMe();
  if (me.data) return <Navigate to="/" replace />;
  return <SignIn />;
}

export function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInRoute />} />
      <Route element={<Shell />}>
        <Route index element={null} />
        <Route path="c/:id" element={<Chat />} />
        <Route path="c/:id/info" element={<ConversationInfo />} />
        <Route path="new" element={<NewChat />} />
        <Route path="new/group" element={<NewGroup />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
