// 全局应用状态:数据加载、增删改、持久化、轻量订阅

import {
  AppSettings,
  FishSchool,
  FishSpecies,
  SeaArea,
  Transducer,
  Voyage,
} from '../types';
import { idb, StoreName } from './db';
import {
  buildDefaultArea,
  buildDefaultSchools,
  buildDefaultSettings,
  buildDefaultSpecies,
  buildDefaultTransducers,
  buildDefaultVoyage,
} from './seed';

export interface AppState {
  area: SeaArea;
  species: FishSpecies[];
  schools: FishSchool[];
  transducers: Transducer[];
  voyages: Voyage[];
  activeVoyageId: string;
  /** 当前选用的换能器 id(最多两个同屏) */
  selectedTxIds: string[];
  settings: AppSettings;
  loaded: boolean;
}

type Listener = (state: AppState) => void;

const SETTINGS_KEY = 'app-settings';

class Store {
  state: AppState = {
    area: buildDefaultArea(),
    species: [],
    schools: [],
    transducers: [],
    voyages: [],
    activeVoyageId: '',
    selectedTxIds: [],
    settings: buildDefaultSettings([]),
    loaded: false,
  };
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  async load() {
    const s = this.state;
    const areas = await idb.getAll<SeaArea>('areas');
    if (areas.length === 0) {
      // 首次启动:写入内置数据
      s.area = buildDefaultArea();
      s.species = buildDefaultSpecies();
      s.schools = buildDefaultSchools();
      s.transducers = buildDefaultTransducers();
      s.voyages = [buildDefaultVoyage()];
      s.settings = buildDefaultSettings(s.transducers);
      await this.persistAll();
    } else {
      s.area = areas[0];
      s.species = await idb.getAll<FishSpecies>('species');
      s.schools = await idb.getAll<FishSchool>('schools');
      s.transducers = await idb.getAll<Transducer>('transducers');
      s.voyages = await idb.getAll<Voyage>('voyages');
      const saved = await idb.get<AppSettings>('settings', SETTINGS_KEY);
      s.settings = saved ?? buildDefaultSettings(s.transducers);
    }
    s.activeVoyageId = s.voyages[0]?.id ?? '';
    if (s.selectedTxIds.length === 0) {
      s.selectedTxIds = s.transducers.slice(0, 2).map((t) => t.id);
    }
    s.loaded = true;
    this.emit();
  }

  private async persistAll() {
    const s = this.state;
    await idb.put('areas', s.area.id, s.area);
    for (const sp of s.species) await idb.put('species', sp.id, sp);
    for (const sc of s.schools) await idb.put('schools', sc.id, sc);
    for (const t of s.transducers) await idb.put('transducers', t.id, t);
    for (const v of s.voyages) await idb.put('voyages', v.id, v);
    await idb.put('settings', SETTINGS_KEY, s.settings);
  }

  async saveArea(area: SeaArea) {
    this.state.area = area;
    await idb.put('areas', area.id, area);
    this.emit();
  }

  async saveSpecies(list: FishSpecies[]) {
    this.state.species = list;
    await idb.clear('species');
    for (const sp of list) await idb.put('species', sp.id, sp);
    this.emit();
  }

  async saveSchools(list: FishSchool[]) {
    this.state.schools = list;
    await idb.clear('schools');
    for (const sc of list) await idb.put('schools', sc.id, sc);
    this.emit();
  }

  async saveTransducers(list: Transducer[]) {
    this.state.transducers = list;
    await idb.clear('transducers');
    for (const t of list) await idb.put('transducers', t.id, t);
    this.emit();
  }

  async saveVoyages(list: Voyage[]) {
    this.state.voyages = list;
    await idb.clear('voyages');
    for (const v of list) await idb.put('voyages', v.id, v);
    this.emit();
  }

  async saveSettings() {
    await idb.put('settings', SETTINGS_KEY, this.state.settings);
    this.emit();
  }

  selectTransducers(ids: string[]) {
    this.state.selectedTxIds = ids.slice(0, 2);
    this.emit();
  }

  setActiveVoyage(id: string) {
    this.state.activeVoyageId = id;
    this.emit();
  }

  async resetToSeed() {
    for (const name of STORE_RESET) await idb.clear(name);
    await this.load();
  }
}

const STORE_RESET: StoreName[] = ['areas', 'species', 'schools', 'transducers', 'voyages', 'settings'];

export const store = new Store();
