import './styles.css';
import { store } from './data/store';
import { renderShell, router, setGlobalClock } from './ui/router';
import { getSimContext } from './ui/sim-context';

async function boot() {
  renderShell('时钟 --:--');
  await store.load();
  getSimContext(); // 预建仿真
  await router();
  // 全局时钟刷新
  setInterval(() => {
    const ctx = getSimContext(true);
    if (!ctx) return;
    const sim = ctx.sim;
    const h = (sim.voyage.startHour + (sim.timeSec * sim.voyage.timeScale) / 3600) % 24;
    const hh = Math.floor(h).toString().padStart(2, '0');
    const mm = Math.floor((h - Math.floor(h)) * 60).toString().padStart(2, '0');
    setGlobalClock(`仿真时钟 ${hh}:${mm}  |  t=${sim.timeSec.toFixed(0)}s`);
  }, 500);
}

boot();
