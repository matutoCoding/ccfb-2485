// IndexedDB 封装：海区 / 鱼种 / 鱼群 / 换能器 / 航次 / 全局设置
// Float32Array/Uint8Array 以类型化数组直接存入 IndexedDB（结构化克隆支持）

import type {
  DBSchema, DisplaySettings, FishSchool, FishSpecies, NoiseSettings, SeaArea, Transducer, Voyage,
} from './types';
import { buildSeedData } from './seed';

const DB_NAME = 'sonar-sim-db';
const DB_VER = 7; // 提升版本号触发 onupgradeneeded，重建内置种子标定

export const DEFAULT_DISPLAY: DisplaySettings = {
  gainDb: 0,
  tvgMode: 'single',
  tvgStrength: 1,
  clutterDb: 0,
  colormap: 'sonar',
  rangeM: 0,
  bottomLockM: 0,
  zoomStep: 0,
};

export const DEFAULT_NOISE: NoiseSettings = {
  wakeBubbles: true, wakeLevel: 0.4,
  engine: false, engineLevel: 0.5,
  crosstalk: false, crosstalkLevel: 0.5,
  ambient: 8,
};

type StoreName = 'areas' | 'species' | 'schools' | 'transducers' | 'voyages' | 'settings';
const STORES: StoreName[] = ['areas', 'species', 'schools', 'transducers', 'voyages', 'settings'];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
        db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  }));
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.getAll());
}
export async function getOne<T>(store: StoreName, id: string): Promise<T | undefined> {
  return tx<T | undefined>(store, 'readonly', (s) => s.get(id));
}
export async function putOne<T extends { id: string }>(store: StoreName, obj: T): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put(obj));
}
export async function deleteOne(store: StoreName, id: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(id));
}
export async function clearStore(store: StoreName): Promise<void> {
  await tx(store, 'readwrite', (s) => s.clear());
}

export async function loadAll(): Promise<DBSchema> {
  const [areas, species, schools, transducers, voyages, settings] = await Promise.all([
    getAll<SeaArea>('areas'),
    getAll<FishSpecies>('species'),
    getAll<FishSchool>('schools'),
    getAll<Transducer>('transducers'),
    getAll<Voyage>('voyages'),
    getAll<{ id: 'global'; display: DisplaySettings; noise: NoiseSettings }>('settings'),
  ]);
  if (areas.length === 0) {
    const seed = buildSeedData();
    await Promise.all([
      ...seed.areas.map((a) => putOne('areas', a)),
      ...seed.species.map((s) => putOne('species', s)),
      ...seed.schools.map((s) => putOne('schools', s)),
      ...seed.transducers.map((t) => putOne('transducers', t)),
      ...seed.voyages.map((v) => putOne('voyages', v)),
      putOne('settings', { id: 'global', display: DEFAULT_DISPLAY, noise: DEFAULT_NOISE }),
    ]);
    return seed;
  }  return {
    areas, species, schools, transducers, voyages,
    settings: settings[0] ?? { id: 'global', display: DEFAULT_DISPLAY, noise: DEFAULT_NOISE },
  };
}

export async function saveSettings(display: DisplaySettings, noise: NoiseSettings): Promise<void> {
  await putOne('settings', { id: 'global', display, noise });
}

export async function resetToSeed(): Promise<DBSchema> {
  await Promise.all(STORES.map((s) => clearStore(s)));
  dbPromise = null;
  return loadAll();
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}
