import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import RxPage from "./pages/RxPage";
import TxPage from "./pages/TxPage";

function linkClass(isActive: boolean) {
  return [
    "rounded-full border px-4 py-2 text-sm font-semibold transition",
    isActive
      ? "border-teal-700 bg-teal-700 text-white shadow-lg shadow-teal-200"
      : "border-slate-300 bg-white/70 text-slate-700 hover:border-teal-600 hover:text-teal-700",
  ].join(" ");
}

function App() {
  return (
    <div className="mx-auto min-h-screen w-full max-w-6xl px-4 pb-10 pt-6 sm:px-6 lg:px-8">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--line)] bg-[var(--panel)] px-5 py-4 backdrop-blur">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
            FASK Lab
          </p>
          <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
            Audio FSK (V2)
          </h1>
        </div>

        <nav className="flex items-center gap-2">
          <NavLink to="/tx" className={({ isActive }) => linkClass(isActive)}>
            TX
          </NavLink>
          <NavLink to="/rx" className={({ isActive }) => linkClass(isActive)}>
            RX
          </NavLink>
        </nav>
      </header>

      <Routes>
        <Route path="/" element={<Navigate to="/tx" replace />} />
        <Route path="/tx" element={<TxPage />} />
        <Route path="/rx" element={<RxPage />} />
      </Routes>
    </div>
  );
}

export default App;
