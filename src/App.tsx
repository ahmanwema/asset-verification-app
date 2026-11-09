import { Navigate, Route, Routes, useParams, useSearchParams } from 'react-router-dom'
import AppShell from './components/AppShell'
import LoginPage from './pages/LoginPage'
import InspectPage from './pages/InspectPage'
import FloorPage from './pages/FloorPage'
import RoomPage from './pages/RoomPage'
import EntryPage from './pages/EntryPage'
import DashboardPage from './pages/DashboardPage'
import ReportsPage from './pages/ReportsPage'
import ReportViewPage from './pages/ReportViewPage'
import LabelsPage from './pages/LabelsPage'
import SetupPage from './pages/SetupPage'
import SyncPage from './pages/SyncPage'
import AssetPage from './pages/AssetPage'
import FinanceRegisterPage from './pages/FinanceRegisterPage'
import AssetFinancePage from './pages/AssetFinancePage'
import { useSession } from './state/session'
import { useT } from './i18n'

/**
 * Forces a fresh EntryPage per item.
 *
 * React Router keeps one component instance across a change of params, so
 * walking from one asset type to the next reused the form: the hydration
 * effect saw it was already loaded and skipped, leaving the previous item's
 * values — quantity, condition, and anything photo recognition had filled in
 * — on screen under the new item's name, ready to be saved to it.
 *
 * Keying on the item remounts instead, which resets every field by
 * construction rather than by remembering to clear each one.
 */
function KeyedEntryPage() {
  const { roomId = '', assetTypeId = '' } = useParams()
  const [search] = useSearchParams()
  return <EntryPage key={`${roomId}|${assetTypeId}|${search.get('entry') ?? ''}`} />
}

export default function App() {
  const { ready, inspector } = useSession()
  const t = useT()

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">{t('common.loading')}</div>
    )
  }

  if (!inspector) return <LoginPage />

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/inspect" replace />} />
        <Route path="/inspect" element={<InspectPage />} />
        <Route path="/inspect/:floorId" element={<FloorPage />} />
        <Route path="/room/:roomId" element={<RoomPage />} />
        <Route path="/room/:roomId/item/:assetTypeId" element={<KeyedEntryPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/reports/:kind" element={<ReportViewPage />} />
        <Route path="/labels" element={<LabelsPage />} />
        <Route path="/asset/:entryId" element={<AssetPage />} />
        <Route path="/asset/:entryId/finance" element={<AssetFinancePage />} />
        <Route path="/finance" element={<FinanceRegisterPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/sync" element={<SyncPage />} />
        <Route path="*" element={<Navigate to="/inspect" replace />} />
      </Routes>
    </AppShell>
  )
}
