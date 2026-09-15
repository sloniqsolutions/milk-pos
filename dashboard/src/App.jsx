import React, { useEffect, useState } from 'react';
import { auth } from './api';
import LoginScreen from './LoginScreen';
import Shell from './Shell';

/**
 * The session cookie is httpOnly, so this code cannot read it. Whether anyone
 * is signed in is therefore not something the page knows — it has to ask, once,
 * on load. That is deliberate: the alternative is a copy of the session in
 * localStorage, which is exactly what an httpOnly cookie exists to avoid.
 */
export default function App() {
  const [user, setUser] = useState(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    auth.me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setChecked(true));
  }, []);

  const signOut = async () => {
    try { await auth.logout(); } catch (e) { /* signing out locally regardless */ }
    setUser(null);
  };

  // Render nothing until the session question is answered, rather than flashing
  // the sign-in form at someone who is already signed in.
  if (!checked) {
    return <div style={{ minHeight: '100vh', background: '#F7F9FC' }} />;
  }

  return user
    ? <Shell user={user} onSignOut={signOut} />
    : <LoginScreen onSignedIn={setUser} />;
}
