import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { useI18n } from "./i18n";
import { Layout } from "./components/Layout";
import { Audit } from "./pages/Audit";
import { ComingSoon, NoAccess } from "./pages/ComingSoon";
import { Billing } from "./pages/Billing";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { Appointments } from "./pages/Appointments";
import { Clinical } from "./pages/Clinical";
import { PatientProfile } from "./pages/PatientProfile";
import { Patients } from "./pages/Patients";
import { Procedures } from "./pages/Procedures";
import { Settings } from "./pages/Settings";
import { Staff } from "./pages/Staff";
import { Users } from "./pages/Users";

function Guard({ module, children }: { module: string; children: ReactNode }) {
  const { can } = useAuth();
  return can(module) ? <>{children}</> : <NoAccess />;
}

export function App() {
  const { me, loading } = useAuth();
  const { t } = useI18n();
  if (loading) return <p className="pad muted">{t("loading")}</p>;
  if (!me) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="settings" element={<Guard module="settings"><Settings /></Guard>} />
        <Route path="users" element={<Guard module="users"><Users /></Guard>} />
        <Route path="staff" element={<Guard module="masterdata"><Staff /></Guard>} />
        <Route path="procedures" element={<Guard module="masterdata"><Procedures /></Guard>} />
        <Route path="audit" element={<Guard module="audit"><Audit /></Guard>} />
        <Route path="patients" element={<Guard module="patients"><Patients /></Guard>} />
        <Route path="patients/:id" element={<Guard module="patients"><PatientProfile /></Guard>} />
        <Route path="appointments" element={<Guard module="appointments"><Appointments /></Guard>} />
        <Route path="clinical" element={<Guard module="clinical"><Clinical /></Guard>} />
        <Route path="billing" element={<Guard module="billing"><Billing /></Guard>} />
        <Route path="lab" element={<ComingSoon title="nav.lab" phase={4} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
