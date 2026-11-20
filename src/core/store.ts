// 全局状态仓库：加载 IndexedDB 数据后在内存维护，变更回写 DB，页面订阅刷新

import type {
  DBSchema, DisplaySettings, FishSchool, FishSpecies, NoiseSettings, SeaArea, Transducer, Voyage,
} from './types';
import {
  DEFAULT_DISPLAY, DEFAULT_NOISE, deleteOne, loadAll, putOne, saveSettings,
} from './db';

type Listener = () => void;

class Store {
  data: DBSchema | null = null;
  selectedAreaId = '';
  selectedTransducerIds: string[] = [];
  selectedVoyageId = '';
  private listeners = new Set<Listener>();

  async init() {
    this.data = await loadAll();
    this.selectedAreaId = this.data.areas[0]?.id ?? '';
    // 默认双频对比：一个 50kHz + 一个 200kHz
    const t50 = this.data.transducers.find((t) => t.frequency < 100000);
    const t200 = this.data.transducers.find((t) => t.frequency >= 100000);
    this.selectedTransducerIds = [t50?.id, t200?.id].filter((x): x is string => !!x).slice(0, 2);
    this.selectedVoyageId = this.data.voyages[0]?.id ?? '';
    this.emit();
  }

  sub(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  get area(): SeaArea {
    const a = this.data!.areas.find((x) => x.id === this.selectedAreaId) ?? this.data!.areas[0];
    return a;
  }
  get schools(): FishSchool[] {
    return this.data!.schools.filter((s) => s.areaId === this.selectedAreaId);
  }
  get transducers(): Transducer[] {
    return this.data!.transducers;
  }
  get selectedTransducers(): Transducer[] {
    return this.selectedTransducerIds
      .map((id) => this.data!.transducers.find((t) => t.id === id))
      .filter((t): t is Transducer => !!t);
  }
  get voyage(): Voyage {
    return this.data!.voyages.find((v) => v.id === this.selectedVoyageId) ?? this.data!.voyages[0];
  }
  get display(): DisplaySettings {
    return this.data!.settings.display;
  }
  get noise(): NoiseSettings {
    return this.data!.settings.noise;
  }
  get species(): FishSpecies[] {
    return this.data!.species;
  }

  async saveArea(a: SeaArea) {
    const i = this.data!.areas.findIndex((x) => x.id === a.id);
    if (i >= 0) this.data!.areas[i] = a; else this.data!.areas.push(a);
    await putOne('areas', a);
    this.emit();
  }
  async deleteArea(id: string) {
    this.data!.areas = this.data!.areas.filter((a) => a.id !== id);
    this.data!.schools = this.data!.schools.filter((s) => s.areaId !== id);
    await deleteOne('areas', id);
    if (this.selectedAreaId === id) this.selectedAreaId = this.data!.areas[0]?.id ?? '';
    this.emit();
  }
  async saveSchool(s: FishSchool) {
    const i = this.data!.schools.findIndex((x) => x.id === s.id);
    if (i >= 0) this.data!.schools[i] = s; else this.data!.schools.push(s);
    await putOne('schools', s);
    this.emit();
  }
  async deleteSchool(id: string) {
    this.data!.schools = this.data!.schools.filter((s) => s.id !== id);
    await deleteOne('schools', id);
    this.emit();
  }
  async saveSpecies(s: FishSpecies) {
    const i = this.data!.species.findIndex((x) => x.id === s.id);
    if (i >= 0) this.data!.species[i] = s; else this.data!.species.push(s);
    await putOne('species', s);
    this.emit();
  }
  async saveTransducer(t: Transducer) {
    const i = this.data!.transducers.findIndex((x) => x.id === t.id);
    if (i >= 0) this.data!.transducers[i] = t; else this.data!.transducers.push(t);
    await putOne('transducers', t);
    this.emit();
  }
  async deleteTransducer(id: string) {
    this.data!.transducers = this.data!.transducers.filter((t) => t.id !== id);
    this.selectedTransducerIds = this.selectedTransducerIds.filter((x) => x !== id);
    await deleteOne('transducers', id);
    this.emit();
  }
  async saveVoyage(v: Voyage) {
    const i = this.data!.voyages.findIndex((x) => x.id === v.id);
    if (i >= 0) this.data!.voyages[i] = v; else this.data!.voyages.push(v);
    await putOne('voyages', v);
    this.emit();
  }
  async deleteVoyage(id: string) {
    this.data!.voyages = this.data!.voyages.filter((v) => v.id !== id);
    await deleteOne('voyages', id);
    this.emit();
  }

  async updateDisplay(patch: Partial<DisplaySettings>) {
    Object.assign(this.data!.settings.display, patch);
    await saveSettings(this.data!.settings.display, this.data!.settings.noise);
    this.emit();
  }
  async updateNoise(patch: Partial<NoiseSettings>) {
    Object.assign(this.data!.settings.noise, patch);
    await saveSettings(this.data!.settings.display, this.data!.settings.noise);
    this.emit();
  }
  async resetSettings() {
    this.data!.settings.display = { ...DEFAULT_DISPLAY };
    this.data!.settings.noise = { ...DEFAULT_NOISE };
    await saveSettings(this.display, this.noise);
    this.emit();
  }
}

export const store = new Store();
