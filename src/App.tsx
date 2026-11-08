import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './components/AppShell'
import LoginPage from './pages/LoginPage'
import InspectPage from './pages/InspectPage'
import FloorPage from './pages/FloorPage'
import RoomPage from './pages/RoomPage'
import EntryPage from './pages/EntryPage'
import DashboardPage from './pages/DashboardPage'
import ReportsPage from './pages/ReportsPage'
import LabelsPage from './pages/LabelsPage'
import SetupPage from './pages/SetupPage'
import SyncPage from './pages/SyncPage'
import { useSession } from './state/session'
import { useT } from './i18n'

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
        <Route path="/room/:roomId/item/:assetTypeId" element={<EntryPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/labels" element={<LabelsPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/sync" element={<SyncPage />} />
        <Route path="*" element={<Navigate to="/inspect" replace />} />
      </Routes>
    </AppShell>
  )
}
