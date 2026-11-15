import { useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Aperture } from 'lucide-react'
import type { AuthStatusDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'

function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden px-5 py-12">
      <div className="pointer-events-none absolute left-1/2 top-[-200px] h-[440px] w-[760px] -translate-x-1/2 rounded-full bg-accent/10 blur-[130px]" />
      <div className="animate-rise relative w-full max-w-[360px]">
        <div className="mb-9 flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <Aperture size={18} />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">MediaVault</span>
        </div>
        <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-ink">{title}</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{subtitle}</p>
        <div className="mt-7">{children}</div>
        {footer}
      </div>
    </div>
  )
}

function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: string
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-[11.5px] text-faint">{hint}</span> : null}
    </label>
  )
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-[#4a2a2e] bg-[#241518] px-3 py-2 text-[12px] text-[#ffc9c9]">
      {message}
    </p>
  )
}

export function SetupPage() {
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)

  const setup = useMutation({
    mutationFn: () => api.setup(username.trim(), password),
    onSuccess: (data) => {
      queryClient.setQueryData<AuthStatusDTO>(['auth'], {
        setupRequired: false,
        authenticated: true,
        user: data.user,
      })
      queryClient.invalidateQueries({ queryKey: ['libraries'] })
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : '계정을 만들지 못했습니다.'),
  })

  return (
    <AuthShell
      title="MediaVault 시작하기"
      subtitle="이 서버의 관리자 계정을 만듭니다. 사진과 영상은 원본 위치에 그대로 남습니다."
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          setError(null)
          if (password !== confirm) {
            setError('비밀번호가 서로 다릅니다.')
            return
          }
          setup.mutate()
        }}
      >
        <Field label="사용자 이름">
          <Input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            placeholder="admin"
          />
        </Field>
        <Field label="비밀번호" hint="8자 이상">
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            placeholder="••••••••"
          />
        </Field>
        <Field label="비밀번호 확인">
          <Input
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            placeholder="••••••••"
          />
        </Field>
        {error ? <ErrorNote message={error} /> : null}
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          disabled={setup.isPending || !username.trim() || password.length < 8}
        >
          {setup.isPending ? '만드는 중' : '계정 만들기'}
        </Button>
      </form>
    </AuthShell>
  )
}

export function LoginPage() {
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const login = useMutation({
    mutationFn: () => api.login(username.trim(), password),
    onSuccess: (data) => {
      queryClient.setQueryData<AuthStatusDTO>(['auth'], {
        setupRequired: false,
        authenticated: true,
        user: data.user,
      })
      queryClient.invalidateQueries({ queryKey: ['libraries'] })
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : '로그인하지 못했습니다.'),
  })

  return (
    <AuthShell title="다시 오셨네요" subtitle="MediaVault에 로그인합니다.">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          setError(null)
          login.mutate()
        }}
      >
        <Field label="사용자 이름">
          <Input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            placeholder="admin"
          />
        </Field>
        <Field label="비밀번호">
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            placeholder="••••••••"
          />
        </Field>
        {error ? <ErrorNote message={error} /> : null}
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          disabled={login.isPending || !username.trim() || !password}
        >
          {login.isPending ? '로그인 중' : '로그인'}
        </Button>
      </form>
    </AuthShell>
  )
}
