import { Routes, Route, Navigate } from "react-router";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Memory from "./pages/Memory";
import MemoryFact from "./pages/MemoryFact";
import MemoryEntity from "./pages/MemoryEntity";
import Graph from "./pages/Graph";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/memory" element={<Memory />} />
        <Route path="/memory/entities/:name" element={<MemoryEntity />} />
        <Route path="/memory/:id" element={<MemoryFact />} />
        <Route path="/memory/facts/:id" element={<MemoryFact />} />
        <Route path="/graph" element={<Graph />} />
      </Route>
    </Routes>
  );
}
