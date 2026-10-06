import type { AuthSession } from "@path/client-core";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

const AuthContext = createContext<AuthSession | null>(null);

export interface AuthGateProps {
  auth: AuthSession;
  children: ReactNode;
}

/**
 * Shows the app only after a user has signed in. A session lost later keeps the app mounted, so
 * unsaved edits survive while the sign-in modal is open over them. Local mode always passes.
 */
export function AuthGate({ auth, children }: AuthGateProps) {
  const userId = useSyncExternalStore(auth.subscribe, auth.userId);
  const [entered, setEntered] = useState(userId !== null);
  if (!entered && userId !== null) setEntered(true);
  if (!entered) return <SignInScreen auth={auth} />;
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}

function SignInScreen({ auth }: { auth: AuthSession }) {
  useEffect(() => {
    void auth.signIn();
  }, [auth]);
  return (
    <main className="sign-in-screen">
      <span className="brand">PATH</span>
      <p>Sign in to continue.</p>
      <button type="button" onClick={() => void auth.signIn()}>
        Sign in
      </button>
    </main>
  );
}

/** Clerk's user menu, for a header. Renders nothing in local mode or outside an `AuthGate`. */
export function UserMenu() {
  const auth = useContext(AuthContext);
  const ref = useRef<HTMLDivElement>(null);
  const hosted = auth?.mode === "hosted";
  useEffect(() => {
    if (!hosted || !auth || !ref.current) return;
    return auth.mountUserButton(ref.current);
  }, [auth, hosted]);
  return hosted ? <div className="user-menu" data-testid="user-menu" ref={ref} /> : null;
}
