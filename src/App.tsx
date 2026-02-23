import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import RxPage from "./pages/RxPage";
import TxPage from "./pages/TxPage";

const navLinkStyle = (isActive: boolean) => ({
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid #d0d7de",
  textDecoration: "none",
  color: isActive ? "#fff" : "#111",
  background: isActive ? "#111" : "#fff",
  fontSize: 13,
});

function App() {
  return (
    <>
      <nav style={{ display: "flex", gap: 8, padding: "16px 16px 0" }}>
        <NavLink to="/tx" style={({ isActive }) => navLinkStyle(isActive)}>
          TX
        </NavLink>
        <NavLink to="/rx" style={({ isActive }) => navLinkStyle(isActive)}>
          RX
        </NavLink>
      </nav>

      <Routes>
        <Route path="/" element={<Navigate to="/tx" replace />} />
        <Route path="/tx" element={<TxPage />} />
        <Route path="/rx" element={<RxPage />} />
      </Routes>
    </>
  );
}

export default App;
