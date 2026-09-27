import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { AUTH_REQUIRED_EVENT, api, type AuthState } from '../api'
import { Button } from './ui'

const AuthContext = createContext<{ state: AuthState; signOut: () => void } | null>(null)
export const useAuth = () => useContext(AuthContext)

/** Shows the sign-in screen until there is a session (or auth is disabled). */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api.me().then(setState).catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    refresh()
    window.addEventListener(AUTH_REQUIRED_EVENT, refresh)
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, refresh)
  }, [refresh])

  const signOut = useCallback(() => {
    api.logout().finally(refresh)
  }, [refresh])

  if (!state) {
    return <div className="grid h-full place-items-center text-sm text-muted">{error ?? 'Loading…'}</div>
  }
  if (state.auth_enabled && !state.user) return <SignIn onSignedIn={setState} />
  return <AuthContext.Provider value={{ state, signOut }}>{children}</AuthContext.Provider>
}

function SignIn({ onSignedIn }: { onSignedIn: (s: AuthState) => void }) {
  const [username, setUsername] = useState('owner')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onSignedIn(await api.login(username, password))
    } catch {
      setError('Wrong username or password.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid h-full place-items-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-panel p-6">
        <div>
          <h1 className="text-lg font-semibold">LLMCoach</h1>
          <p className="text-sm text-muted">Sign in. On BigBox, the password is in BoxPilot's Sign in panel for this app.</p>
        </div>
        <label className="block text-sm">
          <span className="text-muted">Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username"
                 className="mt-1 w-full rounded border border-line bg-bg px-3 py-2 outline-none focus:border-accent" />
        </label>
        <label className="block text-sm">
          <span className="text-muted">Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus
                 autoComplete="current-password"
                 className="mt-1 w-full rounded border border-line bg-bg px-3 py-2 outline-none focus:border-accent" />
        </label>
        {error && <div className="text-sm text-bad">{error}</div>}
        <Button type="submit" disabled={busy || !password} className="w-full">{busy ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </div>
  )
}
