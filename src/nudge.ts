/**
 * PUBLIC STUB — AI Builder Cup 2026 edition.
 * CareGenicsAI's health-nudge scheduling and clinical check-in logic is proprietary and not included.
 * Same interface; nudges are disabled in this edition.
 */
import { db } from './store';

export type NudgeKind = 'walk' | 'glucose' | 'symptoms' | 'meal';
export const NUDGE_ORDER: NudgeKind[] = ['walk', 'glucose', 'symptoms', 'meal'];
export const FIRST_DELAY_MS = 4000;

export function dueNudge(_now = new Date()): NudgeKind | null { return null; }
export function answered(kind: NudgeKind, answer: string, value?: number) { db.addLog({ type: 'nudge', context: kind, text: answer, value }); }
export function snooze(): number { return 60; }
