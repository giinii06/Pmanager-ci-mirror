import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, RefreshCw } from 'lucide-react'
import type { DiagnosticsReportDTO } from '@mediavault/shared'
import { api } from '../lib/api'
import { formatAgo, formatBytes, formatCount, formatDate } from '../lib/format'
import { Button } from '../components/ui/Button'
import { PageHeading } from '../components/PageHeading'
import { MetricPill, Section } from '../components/ui/Section'
import { Spinner } from '../components/ui/Spinner'

const FLAG_LABEL: Record<keyof DiagnosticsReportDTO['flags'], string> = {
  fileMutation: '파일 삭제 엔진',
  hlsGenerations: 'HLS 세대',
  bulkOperations: '일괄 작업',
  notifications: '알림',
  searchFts: '검색 FTS',
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 py-1.5 last:border-0">
      <dt className="shrink-0 text-[11.5px] text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[12px] tabular-nums text-ink">{value}</dd>
    </div>
  )
}

function downloadClass(): string {
  return 'inline-flex h-8 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-raised px-3 text-[13px] text-ink transition-colors hover:border-[#3a3f4b] hover:bg-[#242832]'
}

export function DiagnosticsPage() {
  const queryClient = useQueryClient()
  const report = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => api.diagnostics('json'),
    refetchInterval: 30_000,
    retry: false,
  })
  const refresh = useMutation({
    mutationFn: () => api.diagnostics('json', true),
    onSuccess: (data) => queryClient.setQueryData(['diagnostics'], data),
  })

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-6 pb-24">
      <PageHeading
        title="진단"
        meta="서버, 데이터베이스, 워커, 큐, 저장 공간, 캐시 상태를 한 번에 확인합니다."
        actions={
          <>
            <a className={downloadClass()} href={api.diagnosticsUrl('json')} download>
              <Download size={12} />
              JSON
            </a>
            <a className={downloadClass()} href={api.diagnosticsUrl('md')} download>
              <Download size={12} />
              Markdown
            </a>
            <Button size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              <RefreshCw size={12} className={refresh.isPending ? 'animate-spin' : undefined} />
              새로고침
            </Button>
          </>
        }
      />

      {report.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : report.isError ? (
        <div className="rounded-panel border border-[#4a2a2e] bg-panel px-5 py-8 text-center">
          <p className="text-[13px] font-medium text-danger">진단 보고서를 만들지 못했습니다.</p>
          <p className="mt-1 text-[12px] text-muted">
            {report.error instanceof Error ? report.error.message : '알 수 없는 오류입니다.'}
          </p>
        </div>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <MetricPill label="버전" value={report.data.app.version} />
            <MetricPill
              label="가동 시간"
              value={`${formatCount(Math.floor(report.data.app.uptimeSeconds / 3600))}시간`}
            />
            <MetricPill label="스키마" value={`v${report.data.database.schemaVersion}`} />
            <MetricPill label="DB 무결성" value={report.data.database.integrity} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="애플리케이션" description="이 API 프로세스의 정체성입니다.">
              <dl className="px-4 py-2">
                <Row label="시작" value={formatDate(report.data.app.startedAt)} />
                <Row label="PID" value={String(report.data.app.pid)} />
                <Row label="Bun" value={report.data.app.bunVersion} />
                <Row label="생성" value={`${formatDate(report.data.generatedAt)} (${formatAgo(report.data.generatedAt)})`} />
              </dl>
            </Section>

            <Section title="데이터베이스" description="SQLite 파일과 WAL 크기, 페이지 통계입니다.">
              <dl className="px-4 py-2">
                <Row label="SQLite" value={report.data.database.sqliteVersion} />
                <Row label="저널 모드" value={report.data.database.journalMode} />
                <Row label="동기화" value={report.data.database.synchronousMode} />
                <Row label="DB 크기" value={formatBytes(report.data.database.dbBytes)} />
                <Row label="WAL 크기" value={formatBytes(report.data.database.walBytes)} />
                <Row
                  label="페이지"
                  value={`${formatCount(report.data.database.pageCount)} (freelist ${formatCount(report.data.database.freelistCount)})`}
                />
                <Row label="busy timeout" value={`${report.data.database.busyTimeoutMs}ms`} />
              </dl>
            </Section>

            <Section title="워커" description="부팅별 heartbeat와 현재 리스입니다.">
              <div className="divide-y divide-line/70">
                {report.data.workers.heartbeats.length === 0 ? (
                  <p className="px-4 py-4 text-[12px] text-muted">등록된 워커가 없습니다.</p>
                ) : (
                  report.data.workers.heartbeats.map((beat) => (
                    <div key={beat.instanceId} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                      <span className="text-[12px] font-medium text-ink">{beat.workerId}</span>
                      <span className="rounded border border-line bg-panel-2 px-1.5 py-0.5 text-[10.5px] text-muted">
                        {beat.state}
                      </span>
                      <span className="text-[11px] text-faint">
                        pid {beat.pid} · {formatAgo(beat.lastSeenAt)}
                      </span>
                      {beat.currentJobId !== null ? (
                        <span className="ml-auto text-[11px] text-muted">job #{beat.currentJobId}</span>
                      ) : null}
                    </div>
                  ))
                )}
                {report.data.workers.activeLeases.map((lease) => (
                  <div
                    key={`${lease.workerId}-${lease.jobId}`}
                    className="flex flex-wrap items-center gap-2 px-4 py-2 text-[11.5px] text-muted"
                  >
                    <span className="text-ink">
                      #{lease.jobId} {lease.kind}
                    </span>
                    <span>{lease.phase ?? 'phase 없음'}</span>
                    <span className="ml-auto">
                      {formatCount(lease.progressCurrent)}
                      {lease.progressTotal !== null ? `/${formatCount(lease.progressTotal)}` : ''}
                    </span>
                  </div>
                ))}
                {report.data.workers.gpuLeases.map((lease) => (
                  <div key={lease.resourceId} className="flex flex-wrap items-center gap-2 px-4 py-2 text-[11.5px] text-muted">
                    <span className="text-ink">GPU {lease.resourceId}</span>
                    <span>{lease.taskKind}</span>
                    <span className={lease.expired ? 'text-rose-500' : 'text-emerald-500'}>
                      {lease.expired ? '만료' : '유효'}
                    </span>
                    <span className="ml-auto">{formatDate(lease.leaseExpiresAt)}</span>
                  </div>
                ))}
              </div>
            </Section>

            <Section title="큐" description="미디어 작업과 파이프라인별 대기열입니다.">
              <div className="grid grid-cols-3 gap-2 p-4 sm:grid-cols-5">
                {Object.entries(report.data.queues.counts).map(([state, count]) => (
                  <MetricPill key={state} label={state} value={formatCount(count)} />
                ))}
              </div>
              <dl className="px-4 pb-3">
                <Row label="멈춘 작업" value={formatCount(report.data.queues.stalled)} />
                <Row label="남은 작업" value={formatCount(report.data.queues.remaining)} />
              </dl>
            </Section>

            <Section title="백업" description="DB 백업 기록입니다. 외부 복사 여부는 확인하지 않습니다.">
              <dl className="px-4 py-2">
                <Row label="최근 백업" value={report.data.backups.latest?.filename ?? '없음'} />
                <Row label="최근 성공" value={report.data.backups.lastSuccessAt ? formatAgo(report.data.backups.lastSuccessAt) : '없음'} />
                <Row
                  label="경과"
                  value={
                    report.data.backups.lastSuccessAgeHours === null
                      ? '-'
                      : `${formatCount(report.data.backups.lastSuccessAgeHours)}시간`
                  }
                />
                <Row label="보관 수" value={formatCount(report.data.backups.count)} />
                <Row label="총 크기" value={formatBytes(report.data.backups.totalBytes)} />
                <Row label="외부 복사" value="unknown" />
              </dl>
            </Section>

            <Section title="저장 공간" description="볼륨별 여유 공간과 종류별 사용량입니다.">
              <div className="space-y-2 p-4">
                {report.data.storage.volumes.map((volume) => (
                  <div key={volume.label} className="rounded-lg border border-line bg-panel-2 px-3 py-2">
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="font-medium text-ink">{volume.label}</span>
                      <span className="tabular-nums text-muted">
                        {volume.stale
                          ? '측정 실패'
                          : `${formatBytes(volume.freeBytes ?? 0)} 여유 / ${formatBytes(volume.totalBytes ?? 0)}`}
                      </span>
                    </div>
                    {volume.stale || volume.freeRatio === null ? null : (
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${Math.min(100, Math.max(0, (1 - volume.freeRatio) * 100))}%` }}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <dl className="px-4 pb-3">
                {report.data.storage.categories.map((category) => (
                  <Row
                    key={category.type}
                    label={category.type}
                    value={`${formatBytes(category.bytes)} · ${formatCount(category.files)}개`}
                  />
                ))}
              </dl>
            </Section>
          </div>

          <Section title="캐시" description="재생성 가능한 데이터입니다. 원본과 격리 파일은 포함되지 않습니다.">
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="border-b border-line text-[11px] text-muted">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">종류</th>
                    <th className="px-3 py-2 text-right font-medium">용량</th>
                    <th className="px-3 py-2 text-right font-medium">파일</th>
                    <th className="px-3 py-2 text-right font-medium">가장 오래됨</th>
                    <th className="px-4 py-2 text-right font-medium">상태</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.caches.types.map((type) => (
                    <tr key={type.type} className="border-b border-line/60 last:border-0">
                      <td className="px-4 py-2 text-ink">{type.type}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">{formatBytes(type.bytes)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">{formatCount(type.files)}</td>
                      <td className="px-3 py-2 text-right text-muted">
                        {type.oldestAt ? formatAgo(type.oldestAt) : '-'}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <span
                          className={
                            type.protected
                              ? 'rounded border border-line bg-panel-2 px-1.5 py-0.5 text-[10.5px] text-muted'
                              : 'rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10.5px] text-emerald-500'
                          }
                        >
                          {type.protected ? '보호' : '정리 가능'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="알림 · 기능 플래그" description="알림 인박스와 각 기능의 활성 상태입니다.">
            <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4">
              <MetricPill label="진행 중" value={formatCount(report.data.notifications.open)} />
              <MetricPill label="읽지 않음" value={formatCount(report.data.notifications.unread)} />
              <MetricPill label="최근 24시간" value={formatCount(report.data.notifications.last24h)} />
            </div>
            <dl className="px-4 pb-3">
              {(Object.keys(FLAG_LABEL) as Array<keyof DiagnosticsReportDTO['flags']>).map((flag) => (
                <Row key={flag} label={FLAG_LABEL[flag]} value={report.data.flags[flag] ? '켜짐' : '꺼짐'} />
              ))}
            </dl>
          </Section>
        </>
      )}
    </div>
  )
}
