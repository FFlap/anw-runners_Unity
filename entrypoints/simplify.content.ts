import type {
  AutofillFieldKey,
  DetectedFormField,
  RewriteLevel,
  RuntimeRequest,
} from '@/lib/types';
import {
  AUDIO_FOLLOW_MODE_STORAGE_KEY,
  AUDIO_RATE_STORAGE_KEY,
  COLOR_BLIND_MODE_STORAGE_KEY,
  FORCED_FONT_STORAGE_KEY,
  REDUCE_MOTION_STORAGE_KEY,
  normalizeForcedFont,
  type ForcedFontOption,
} from '@/lib/storage';

const STYLE_ID = 'cred-selection-actions-style';
const PAGE_STYLE_ID = 'cred-page-colorblind-style';
const PAGE_FONT_STYLE_ID = 'cred-page-forced-font-style';
const PAGE_REDUCED_MOTION_STYLE_ID = 'cred-page-reduced-motion-style';
const ACTION_BAR_ID = 'cred-selection-actions';
const CARD_ID = 'cred-selection-result-card';
const AUDIO_FOLLOW_PANEL_ID = 'unity-audio-follow-panel';
const UI_ATTR = 'data-cred-selection-ui';
const MOTION_EXEMPT_ATTR = 'data-unity-motion-exempt';
const PAGE_MODE_ATTR = 'data-unity-color-blind-page';
const PAGE_FONT_ATTR = 'data-unity-forced-font';
const PAGE_REDUCED_MOTION_ATTR = 'data-unity-reduced-motion';
const GIF_FROZEN_ATTR = 'data-unity-rm-gif-frozen';
const GIF_FROZEN_SRC_ATTR = 'data-unity-rm-gif-frozen-src';
const GIF_FROZEN_PENDING_SRC = '__unity-pending-freeze__';
const GIF_PENDING_ATTR = 'data-unity-rm-gif-pending';
const GIF_ORIGINAL_ATTR = 'data-unity-rm-gif-original';
const CANVAS_FROZEN_ATTR = 'data-unity-rm-canvas-frozen';
const CANVAS_ORIGINAL_VISIBILITY_ATTR = 'data-unity-rm-canvas-original-visibility';
const CANVAS_PLACEHOLDER_ID_ATTR = 'data-unity-rm-canvas-placeholder-id';
const CANVAS_PLACEHOLDER_ATTR = 'data-unity-rm-canvas-placeholder';
const CANVAS_PLACEHOLDER_ID_PREFIX = 'unity-rm-canvas-placeholder-';
const SHADOW_FONT_STYLE_ATTR = 'data-unity-forced-font-shadow-style';
const ATTACH_SHADOW_HOOK_ATTR = 'data-unity-attach-shadow-hook';
const MIN_SELECTION_CHARS = 16;
const POINTER_ANCHOR_MAX_AGE_MS = 2_500;
const AUDIO_PAGE_FOLLOW_PROGRESS_LAG = 0.07;
const AUDIO_PAGE_FOLLOW_LINE_ADVANCE_HYSTERESIS = 0.38;
const AUDIO_PAGE_FOLLOW_MIN_ADVANCE_MS = 320;
const REDUCE_MOTION_RESCAN_INTERVAL_MS = 900;

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;
let latestUndoEntries: UndoFillEntry[] | null = null;

type SelectionAction = 'simplify' | 'summarize';
type CardState = 'loading' | 'done' | 'error';

interface SelectionSnapshot {
  text: string;
  rect: DOMRect;
  anchorX: number;
  anchorY: number;
}

interface PointerAnchor {
  x: number;
  y: number;
  at: number;
}

interface ActionConfig {
  label: string;
  title: string;
  loadingText: string;
  emptyErrorText: string;
}

interface ActionResponse {
  ok: boolean;
  result?: string;
  error?: string;
}

type AudioContentRequest =
  | { type: 'AUDIO_GET_STATE' }
  | { type: 'AUDIO_GET_SELECTION' }
  | { type: 'AUDIO_READ_SELECTION'; rate?: number; followMode?: boolean }
  | { type: 'AUDIO_PLAY' }
  | { type: 'AUDIO_PAUSE' }
  | { type: 'AUDIO_STOP' }
  | { type: 'AUDIO_SET_RATE'; rate: number }
  | { type: 'AUDIO_SET_FOLLOW_MODE'; enabled: boolean };

type FormFieldScanRequest = { type: 'FORM_SCAN_FIELDS' };
type FormFillSelection = {
  index: number;
  fieldKey: AutofillFieldKey;
  value: string;
};
type FormFieldFillRequest = { type: 'FORM_FILL_FIELDS'; selections: FormFillSelection[] };
type FormUndoFillRequest = { type: 'FORM_UNDO_FILL' };
type FormUndoStatusRequest = { type: 'FORM_GET_UNDO_STATUS' };
type ContentRequest =
  | AudioContentRequest
  | FormFieldScanRequest
  | FormFieldFillRequest
  | FormUndoFillRequest
  | FormUndoStatusRequest;

interface FormFillSummary {
  requested: number;
  filled: number;
  skipped: number;
  skippedByReason: Record<string, number>;
}

interface FormUndoSummary {
  undoable: number;
  restored: number;
  skipped: number;
  skippedByReason: Record<string, number>;
}

interface AudioContentState {
  available: boolean;
  hasSelection: boolean;
  selectionText: string;
  isSpeaking: boolean;
  isPaused: boolean;
  rate: number;
  followMode: boolean;
  currentLineIndex: number;
  totalLines: number;
  currentLineText: string;
}

interface SelectionLineRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const KNOWN_SHADOW_ROOTS = new Set<ShadowRoot>();

const REWRITE_LEVELS: RewriteLevel[] = [1, 2, 3];
const LEVEL_LABELS: Record<RewriteLevel, string> = {
  1: 'L1',
  2: 'L2',
  3: 'L3',
};

const ACTION_CONFIG: Record<SelectionAction, ActionConfig> = {
  simplify: {
    label: 'Simplify',
    title: 'Plain-language version',
    loadingText: 'Simplifying selected text...',
    emptyErrorText: 'Could not simplify text. Make sure your API key is set in the extension popup.',
  },
  summarize: {
    label: 'Summarize',
    title: 'Concise summary',
    loadingText: 'Summarizing selected text...',
    emptyErrorText: 'Could not summarize text. Make sure your API key is set in the extension popup.',
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampAudioRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return clamp(rate, 0.75, 2);
}

function normalizeInlineText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeFieldSignal(value: string | null | undefined): string {
  return ` ${normalizeInlineText(
    (value ?? '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_./-]+/g, ' '),
  )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')} `;
}

function extractElementText(element: Element | null): string {
  return normalizeInlineText(element?.textContent ?? '');
}

function collectAssociatedLabelText(
  field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): string {
  const candidates = new Set<string>();
  const addCandidate = (value: string | null | undefined) => {
    const normalized = normalizeInlineText(value);
    if (!normalized) return;
    candidates.add(normalized.slice(0, 180));
  };

  for (const label of Array.from(field.labels ?? [])) {
    addCandidate(extractElementText(label));
  }

  const rawId = normalizeInlineText(field.id);
  if (rawId && typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    for (const label of Array.from(document.querySelectorAll(`label[for="${CSS.escape(rawId)}"]`))) {
      addCandidate(extractElementText(label));
    }
  }

  addCandidate(extractElementText(field.closest('label')));
  addCandidate(field.getAttribute('aria-label'));

  const labelledBy = normalizeInlineText(field.getAttribute('aria-labelledby'));
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      addCandidate(extractElementText(document.getElementById(id)));
    }
  }

  const parent = field.parentElement;
  if (parent) {
    const directLabel = parent.querySelector(':scope > label, :scope > legend, :scope > .label, :scope > [data-label]');
    if (directLabel && !directLabel.contains(field)) {
      addCandidate(extractElementText(directLabel));
    }

    let previousSibling = field.previousElementSibling;
    while (previousSibling) {
      if (!previousSibling.matches('script,style')) {
        const text = extractElementText(previousSibling);
        if (text) {
          addCandidate(text);
          break;
        }
      }
      previousSibling = previousSibling.previousElementSibling;
    }
  }

  const fieldsetLegend = field.closest('fieldset')?.querySelector('legend');
  addCandidate(extractElementText(fieldsetLegend ?? null));

  const tableCell = field.closest('td,th');
  if (tableCell) {
    addCandidate(extractElementText(tableCell.previousElementSibling));
    const rowHeader = tableCell.parentElement?.querySelector('th');
    if (rowHeader && !rowHeader.contains(field)) {
      addCandidate(extractElementText(rowHeader));
    }
  }

  return Array.from(candidates).join(' | ');
}

function classifyFromAutocomplete(autocomplete: string): AutofillFieldKey | null {
  if (!autocomplete) return null;

  const tokens = autocomplete
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .reverse();

  for (const token of tokens) {
    if (
      token.startsWith('section-') ||
      token === 'shipping' ||
      token === 'billing' ||
      token === 'home' ||
      token === 'work'
    ) {
      continue;
    }
    if (token === 'email') return 'email';
    if (token === 'given-name') return 'firstName';
    if (token === 'family-name') return 'lastName';
    if (token === 'name') return 'fullName';
    if (token === 'street-address' || token === 'address-line1') return 'addressLine1';
    if (token === 'address-line2' || token === 'address-line3') return 'addressLine2';
    if (token === 'address-level2') return 'city';
    if (token === 'address-level1') return 'stateProvince';
    if (token === 'postal-code') return 'postalZip';
    if (token === 'country' || token === 'country-name') return 'country';
    if (token === 'tel' || token.startsWith('tel-')) return 'phone';
  }

  return null;
}

function classifyFieldKey({
  inputType,
  autocomplete,
  labelText,
  placeholder,
  name,
  id,
}: {
  inputType: string;
  autocomplete: string;
  labelText: string;
  placeholder: string;
  name: string;
  id: string;
}): AutofillFieldKey | null {
  const fromAutocomplete = classifyFromAutocomplete(autocomplete);
  if (fromAutocomplete) return fromAutocomplete;

  if (inputType === 'email') return 'email';
  if (inputType === 'tel') return 'phone';

  const signal = normalizeFieldSignal(`${labelText} ${placeholder} ${name} ${id}`);

  if (!signal.trim()) return null;
  const hasEmailSignal = /\b(e mail|email)\b/.test(signal);
  const hasPhoneSignal = /\b(phone|mobile|telephone|tel|cell)\b/.test(signal);
  const hasFirstNameSignal = /\b(first|given)\s+name\b|\bgivenname\b|\bfname\b/.test(signal);
  const hasLastNameSignal = /\b(last|family|sur|surname)\s+name\b|\bfamilyname\b|\blname\b/.test(signal);
  const hasAddressLine2Signal =
    /\b(address|addr)\s*(line)?\s*2\b|\b(address|addr)\s*(line)?\s*two\b|\bapt\b|\bapartment\b|\bsuite\b|\bste\b|\bunit\b|\bbuilding\b|\bfloor\b|\bfl\b/.test(
      signal,
    );
  const hasAddressLine1Signal =
    /\baddress\s*(line)?\s*1\b|\baddress\s*(line)?\s*one\b|\bstreet\s*address\b|\b(address|addr|street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|house\s*number|street\s*name)\b/.test(
      signal,
    );
  const hasCitySignal = /\bcity\b|\btown\b|\bmunicipality\b|\bsuburb\b|\bdistrict\b|\bneighbo[u]?rhood\b/.test(
    signal,
  );
  const hasStateSignal = /\bstate\b|\bprovince\b|\bregion\b|\bcounty\b/.test(signal);
  const hasPostalSignal = /\bzip\b|\bpostal\b|\bpostcode\b|\bpost\s*code\b|\bpin\s*code\b/.test(signal);
  const hasCountrySignal = /\bcountry\b|\bnation\b/.test(signal);

  if (hasEmailSignal) return 'email';
  if (hasPhoneSignal) return 'phone';
  if (hasAddressLine2Signal) return 'addressLine2';
  if (hasAddressLine1Signal) return 'addressLine1';
  if (hasCitySignal) return 'city';
  if (hasStateSignal) return 'stateProvince';
  if (hasPostalSignal) return 'postalZip';
  if (hasCountrySignal) return 'country';
  if (hasFirstNameSignal) return 'firstName';
  if (hasLastNameSignal) return 'lastName';

  const hasOrgOrAccountSignal =
    /\b(company|business|organization|organisation|org|username|user\s*name|account|login)\b/.test(signal);

  if (/\b(full|your|contact)\s+name\b|\bfullname\b/.test(signal)) return 'fullName';
  if (/\bname\b/.test(signal) && !hasOrgOrAccountSignal) return 'fullName';

  return null;
}

function isFillableField(
  field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): boolean {
  if (!field.isConnected) return false;
  if (field.closest('[hidden]')) return false;
  if (field.disabled) return false;

  if (field instanceof HTMLInputElement) {
    const inputType = (field.getAttribute('type') ?? 'text').toLowerCase();
    if (['hidden', 'submit', 'reset', 'button', 'image', 'file'].includes(inputType)) return false;
    if (field.readOnly) return false;
  }

  if (field instanceof HTMLTextAreaElement && field.readOnly) {
    return false;
  }

  const style = window.getComputedStyle(field);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (field.getClientRects().length === 0) return false;

  return true;
}

type FillableFormElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

interface FillableFormFieldEntry {
  element: FillableFormElement;
  field: DetectedFormField;
}

interface UndoFillEntry {
  element: FillableFormElement;
  previousValue: string;
}

function detectFillableFormFieldEntries(): FillableFormFieldEntry[] {
  const elements = Array.from(
    document.querySelectorAll<FillableFormElement>('input, textarea, select'),
  );

  const fields: FillableFormFieldEntry[] = [];

  for (const field of elements) {
    if (!isFillableField(field)) continue;

    const elementType: DetectedFormField['elementType'] =
      field instanceof HTMLInputElement
        ? 'input'
        : field instanceof HTMLTextAreaElement
          ? 'textarea'
          : 'select';
    const inputType = field instanceof HTMLInputElement
      ? (field.getAttribute('type') ?? 'text').toLowerCase()
      : field instanceof HTMLTextAreaElement
        ? 'textarea'
        : field.multiple
          ? 'select-multiple'
          : 'select-one';
    const name = normalizeInlineText(field.getAttribute('name'));
    const id = normalizeInlineText(field.id);
    const autocomplete = normalizeInlineText(field.getAttribute('autocomplete'));
    const placeholder =
      field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
        ? normalizeInlineText(field.getAttribute('placeholder'))
        : '';
    const labelText = collectAssociatedLabelText(field);
    const fieldKey = classifyFieldKey({
      inputType,
      autocomplete,
      labelText,
      placeholder,
      name,
      id,
    });

    fields.push({
      element: field,
      field: {
        index: fields.length,
        elementType,
        inputType,
        name,
        id,
        autocomplete,
        placeholder,
        labelText,
        fieldKey,
      },
    });
  }

  return fields;
}

function detectFillableFormFields(): DetectedFormField[] {
  return detectFillableFormFieldEntries().map((entry) => entry.field);
}

function isCreditCardLikeField(field: DetectedFormField): boolean {
  const autocomplete = field.autocomplete.toLowerCase();
  if (
    /\bcc-(name|number|exp|exp-month|exp-year|csc|type)\b/.test(autocomplete) ||
    autocomplete === 'cc-name' ||
    autocomplete === 'cc-number' ||
    autocomplete === 'cc-exp' ||
    autocomplete === 'cc-exp-month' ||
    autocomplete === 'cc-exp-year' ||
    autocomplete === 'cc-csc'
  ) {
    return true;
  }

  const signal = normalizeInlineText(
    `${field.labelText} ${field.placeholder} ${field.name} ${field.id} ${field.autocomplete}`,
  )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');

  return /\b(credit|debit|card|cc number|card number|cvv|cvc|security code|expiry|expiration|exp date)\b/.test(
    signal,
  );
}

function setNativeFieldValue(element: FillableFormElement, nextValue: string): void {
  const prototype =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLSelectElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) {
    descriptor.set.call(element, nextValue);
    return;
  }
  element.value = nextValue;
}

function dispatchInputAndChange(element: FillableFormElement): void {
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function resolveSelectOptionValue(select: HTMLSelectElement, targetValue: string): string | null {
  const options = Array.from(select.options);
  const exactRawMatch = options.find((option) => option.value === targetValue);
  if (exactRawMatch) return exactRawMatch.value;

  const normalizedTarget = normalizeInlineText(targetValue);
  if (!normalizedTarget) return null;

  const exactValue = options.find((option) => option.value === normalizedTarget);
  if (exactValue) return exactValue.value;

  const normalizedLower = normalizedTarget.toLowerCase();
  const normalizedValueMatch = options.find(
    (option) => normalizeInlineText(option.value).toLowerCase() === normalizedLower,
  );
  if (normalizedValueMatch) return normalizedValueMatch.value;

  const textMatch = options.find(
    (option) => normalizeInlineText(option.textContent ?? '').toLowerCase() === normalizedLower,
  );
  if (textMatch) return textMatch.value;

  return null;
}

function fillDomField(
  entry: FillableFormFieldEntry,
  value: string,
): { filled: boolean; reason?: string; undoEntry?: UndoFillEntry } {
  const { element } = entry;

  if (!isFillableField(element)) {
    return { filled: false, reason: 'hidden_disabled_or_readonly' };
  }

  if (element instanceof HTMLInputElement) {
    const inputType = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (inputType === 'password') {
      return { filled: false, reason: 'password_field' };
    }
    if (['checkbox', 'radio', 'file', 'range', 'color', 'button', 'submit', 'reset'].includes(inputType)) {
      return { filled: false, reason: 'unsupported_input_type' };
    }
  }

  if (isCreditCardLikeField(entry.field)) {
    return { filled: false, reason: 'credit_card_like_field' };
  }

  const previousValue = element.value;

  if (element instanceof HTMLSelectElement) {
    const optionValue = resolveSelectOptionValue(element, value);
    if (optionValue == null) {
      return { filled: false, reason: 'select_option_not_found' };
    }
    setNativeFieldValue(element, optionValue);
    dispatchInputAndChange(element);
    return {
      filled: true,
      undoEntry:
        previousValue !== optionValue
          ? {
              element,
              previousValue,
            }
          : undefined,
    };
  }

  setNativeFieldValue(element, value);
  dispatchInputAndChange(element);
  return {
    filled: true,
    undoEntry:
      previousValue !== value
        ? {
            element,
            previousValue,
          }
        : undefined,
  };
}

function fillDetectedFormFields(selections: FormFillSelection[]): FormFillSummary {
  latestUndoEntries = null;

  const summary: FormFillSummary = {
    requested: selections.length,
    filled: 0,
    skipped: 0,
    skippedByReason: {},
  };
  const undoEntries: UndoFillEntry[] = [];

  const addSkip = (reason: string) => {
    summary.skipped += 1;
    summary.skippedByReason[reason] = (summary.skippedByReason[reason] ?? 0) + 1;
  };

  const entriesByIndex = new Map(
    detectFillableFormFieldEntries().map((entry) => [entry.field.index, entry]),
  );

  for (const selection of selections) {
    const normalizedValue = normalizeInlineText(selection.value);
    if (!normalizedValue) {
      addSkip('missing_profile_value');
      continue;
    }

    const entry = entriesByIndex.get(selection.index);
    if (!entry) {
      addSkip('field_not_found');
      continue;
    }

    if (entry.field.fieldKey !== selection.fieldKey) {
      addSkip('field_key_mismatch');
      continue;
    }

    const result = fillDomField(entry, normalizedValue);
    if (!result.filled) {
      addSkip(result.reason ?? 'fill_failed');
      continue;
    }

    if (result.undoEntry) {
      undoEntries.push(result.undoEntry);
    }
    summary.filled += 1;
  }

  if (undoEntries.length > 0) {
    latestUndoEntries = undoEntries;
  }

  return summary;
}

function getUndoAvailability(): boolean {
  return Boolean(latestUndoEntries && latestUndoEntries.length > 0);
}

function undoLastFillAction(): FormUndoSummary {
  const entries = latestUndoEntries;
  if (!entries || entries.length === 0) {
    throw new Error('No recent fill action to undo.');
  }
  latestUndoEntries = null;

  const summary: FormUndoSummary = {
    undoable: entries.length,
    restored: 0,
    skipped: 0,
    skippedByReason: {},
  };

  const addSkip = (reason: string) => {
    summary.skipped += 1;
    summary.skippedByReason[reason] = (summary.skippedByReason[reason] ?? 0) + 1;
  };

  for (const entry of entries) {
    if (!entry.element.isConnected) {
      addSkip('field_unavailable');
      continue;
    }

    if (entry.element instanceof HTMLSelectElement) {
      const optionValue = resolveSelectOptionValue(entry.element, entry.previousValue);
      if (optionValue == null) {
        addSkip('select_option_not_found');
        continue;
      }
      setNativeFieldValue(entry.element, optionValue);
      dispatchInputAndChange(entry.element);
      summary.restored += 1;
      continue;
    }

    setNativeFieldValue(entry.element, entry.previousValue);
    dispatchInputAndChange(entry.element);
    summary.restored += 1;
  }

  return summary;
}

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${ACTION_BAR_ID} {
      --cred-ab-bg: #fff7ef;
      --cred-ab-border: #e8dbcf;
      --cred-ab-shadow: rgba(24, 18, 13, 0.25);
      --cred-ab-btn-bg: #af6d3a;
      --cred-ab-btn-text: #fff7ef;
      --cred-ab-level-border: #d9c7b5;
      --cred-ab-level-bg: #fffdf9;
      --cred-ab-level-text: #7a6a5b;
      --cred-ab-level-active-bg: #e8d7c6;
      --cred-ab-level-active-border: #c9ac8d;
      --cred-ab-level-active-text: #5f4935;
      --cred-ab-focus: rgba(175, 109, 58, 0.6);
      --cred-ab-focus-shadow: transparent;
      --cred-ab-outline: transparent;
      position: fixed;
      z-index: 2147483647;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border-radius: 999px;
      padding: 6px;
      background: var(--cred-ab-bg);
      border: 1px solid var(--cred-ab-border);
      box-shadow: 0 10px 22px var(--cred-ab-shadow);
      font-family: "DM Sans", system-ui, sans-serif;
    }
    #${ACTION_BAR_ID}[data-color-blind-mode="true"] {
      --cred-ab-bg: #fbfdff;
      --cred-ab-border: #73889f;
      --cred-ab-shadow: rgba(9, 34, 61, 0.24);
      --cred-ab-btn-bg: #0b5da8;
      --cred-ab-btn-text: #ffffff;
      --cred-ab-level-border: #7088a1;
      --cred-ab-level-bg: #ffffff;
      --cred-ab-level-text: #30465d;
      --cred-ab-level-active-bg: #e6f0fb;
      --cred-ab-level-active-border: #0b5da8;
      --cred-ab-level-active-text: #0b3f70;
      --cred-ab-focus: #005fcc;
      --cred-ab-focus-shadow: rgba(0, 95, 204, 0.32);
      --cred-ab-outline: rgba(7, 65, 121, 0.2);
    }
    #${ACTION_BAR_ID} .cred-action-btn {
      border: 0;
      border-radius: 999px;
      background: var(--cred-ab-btn-bg);
      color: var(--cred-ab-btn-text);
      font: 600 12px/1 "DM Sans", system-ui, sans-serif;
      letter-spacing: 0.01em;
      padding: 9px 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    #${ACTION_BAR_ID} .cred-action-btn:hover {
      filter: brightness(1.06);
    }
    #${ACTION_BAR_ID}[data-color-blind-mode="true"] .cred-action-btn:hover {
      text-decoration: underline;
      text-underline-offset: 2px;
      box-shadow: 0 0 0 2px var(--cred-ab-outline);
    }
    #${ACTION_BAR_ID} .cred-levels {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 0 2px;
    }
    #${ACTION_BAR_ID} .cred-level-btn {
      border: 1px solid var(--cred-ab-level-border);
      border-radius: 999px;
      background: var(--cred-ab-level-bg);
      color: var(--cred-ab-level-text);
      font: 700 11px/1 "DM Sans", system-ui, sans-serif;
      padding: 7px 10px;
      cursor: pointer;
    }
    #${ACTION_BAR_ID} .cred-level-btn[data-active="true"] {
      background: var(--cred-ab-level-active-bg);
      border-color: var(--cred-ab-level-active-border);
      color: var(--cred-ab-level-active-text);
    }
    #${ACTION_BAR_ID} .cred-level-btn:hover {
      filter: brightness(0.98);
    }
    #${ACTION_BAR_ID}[data-color-blind-mode="true"] .cred-level-btn[data-active="true"] {
      border-width: 2px;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    #${ACTION_BAR_ID}[data-color-blind-mode="true"] .cred-level-btn[data-active="true"]::before {
      content: "✓ ";
      font-weight: 900;
    }
    #${ACTION_BAR_ID} .cred-action-btn:focus-visible,
    #${ACTION_BAR_ID} .cred-level-btn:focus-visible,
    #${CARD_ID} .cred-selection-close:focus-visible {
      outline: 2px solid var(--cred-ab-focus);
      outline-offset: 2px;
      box-shadow: 0 0 0 2px var(--cred-ab-focus-shadow);
    }
    #${CARD_ID} {
      --cred-card-border: #e8dbcf;
      --cred-card-bg: #fffcf8;
      --cred-card-text: #2d2520;
      --cred-card-shadow: rgba(24, 18, 13, 0.28);
      --cred-card-head-border: #f0e2d5;
      --cred-card-head-bg: #faf6f0;
      --cred-card-title: #5c4f44;
      --cred-card-close: #6f5e4f;
      --cred-card-close-hover: rgba(175, 109, 58, 0.1);
      --cred-card-loading: #7a6a5b;
      --cred-card-error: #a13f32;
      --cred-card-status-stripe: transparent;
      position: fixed;
      z-index: 2147483647;
      width: min(360px, calc(100vw - 16px));
      border-radius: 12px;
      border: 1px solid var(--cred-card-border);
      background: var(--cred-card-bg);
      color: var(--cred-card-text);
      box-shadow: 0 18px 34px var(--cred-card-shadow);
      font-family: "DM Sans", system-ui, sans-serif;
      overflow: hidden;
    }
    #${CARD_ID}[data-color-blind-mode="true"] {
      --cred-card-border: #7088a1;
      --cred-card-bg: #fcfeff;
      --cred-card-text: #182e44;
      --cred-card-shadow: rgba(9, 34, 61, 0.3);
      --cred-card-head-border: #d2deea;
      --cred-card-head-bg: #f4f9ff;
      --cred-card-title: #2d4358;
      --cred-card-close: #355067;
      --cred-card-close-hover: rgba(11, 93, 168, 0.12);
      --cred-card-loading: #3a536c;
      --cred-card-error: #8d1f31;
      --cred-card-status-stripe: #8ea4bb;
    }
    #${CARD_ID} .cred-selection-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--cred-card-head-border);
      background: var(--cred-card-head-bg);
    }
    #${CARD_ID} .cred-selection-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--cred-card-title);
    }
    #${CARD_ID} .cred-selection-close {
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--cred-card-close);
      font-size: 16px;
      line-height: 1;
      width: 24px;
      height: 24px;
      cursor: pointer;
    }
    #${CARD_ID} .cred-selection-close:hover {
      background: var(--cred-card-close-hover);
    }
    #${CARD_ID} .cred-selection-body {
      margin: 0;
      padding: 12px;
      font-size: 13px;
      line-height: 1.45;
      color: var(--cred-card-text);
      white-space: pre-wrap;
    }
    #${CARD_ID}[data-state="loading"] .cred-selection-body {
      color: var(--cred-card-loading);
      font-style: italic;
    }
    #${CARD_ID}[data-state="error"] .cred-selection-body {
      color: var(--cred-card-error);
    }
    #${CARD_ID}[data-color-blind-mode="true"] .cred-selection-body {
      border-left: 5px solid var(--cred-card-status-stripe);
      padding-left: 10px;
    }
    #${CARD_ID}[data-color-blind-mode="true"][data-state="loading"] .cred-selection-body {
      border-left-color: #4f6f90;
    }
    #${CARD_ID}[data-color-blind-mode="true"][data-state="loading"] .cred-selection-body::before {
      content: "Loading: ";
      font-style: normal;
      font-weight: 700;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    #${CARD_ID}[data-color-blind-mode="true"][data-state="error"] .cred-selection-body {
      border-left-color: #8d1f31;
    }
    #${CARD_ID}[data-color-blind-mode="true"][data-state="error"] .cred-selection-body::before {
      content: "Error: ";
      font-weight: 700;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    #${CARD_ID}[data-color-blind-mode="true"][data-state="done"] .cred-selection-body {
      border-left-color: #0b5da8;
    }
    #${CARD_ID}[data-color-blind-mode="true"] :is(.cred-action-btn, .cred-level-btn, .cred-selection-close):focus-visible {
      outline: 3px solid var(--cred-ab-focus);
      outline-offset: 2px;
      box-shadow: 0 0 0 3px var(--cred-ab-focus-shadow);
    }
    #${AUDIO_FOLLOW_PANEL_ID} {
      --unity-afp-bg: #fffcf8;
      --unity-afp-border: #e8dbcf;
      --unity-afp-text: #2d2520;
      --unity-afp-muted: #6c5d50;
      --unity-afp-line-border: #ecdcca;
      --unity-afp-line-bg: #fffaf3;
      --unity-afp-current-border: #af6d3a;
      --unity-afp-current-bg: #fff2dd;
      --unity-afp-current-shadow: rgba(175, 109, 58, 0.24);
      position: fixed;
      z-index: 2147483647;
      right: 12px;
      bottom: 12px;
      width: min(360px, calc(100vw - 24px));
      max-height: min(42vh, 320px);
      border-radius: 12px;
      border: 1px solid var(--unity-afp-border);
      background: var(--unity-afp-bg);
      color: var(--unity-afp-text);
      box-shadow: 0 16px 30px rgba(24, 18, 13, 0.24);
      font-family: "DM Sans", system-ui, sans-serif;
      overflow: hidden;
    }
    #${AUDIO_FOLLOW_PANEL_ID}[data-color-blind-mode="true"] {
      --unity-afp-bg: #fbfdff;
      --unity-afp-border: #7088a1;
      --unity-afp-text: #182e44;
      --unity-afp-muted: #3a536c;
      --unity-afp-line-border: #cfdcec;
      --unity-afp-line-bg: #f8fbff;
      --unity-afp-current-border: #005fcc;
      --unity-afp-current-bg: #e7f0fb;
      --unity-afp-current-shadow: rgba(0, 95, 204, 0.28);
    }
    #${AUDIO_FOLLOW_PANEL_ID} .unity-afp-head {
      padding: 8px 10px;
      border-bottom: 1px solid var(--unity-afp-line-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: rgba(255, 255, 255, 0.6);
    }
    #${AUDIO_FOLLOW_PANEL_ID} .unity-afp-title {
      margin: 0;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    #${AUDIO_FOLLOW_PANEL_ID} .unity-afp-meta {
      margin: 0;
      font-size: 11px;
      color: var(--unity-afp-muted);
    }
    #${AUDIO_FOLLOW_PANEL_ID} .unity-afp-lines {
      margin: 0;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 252px;
      overflow: auto;
    }
    #${AUDIO_FOLLOW_PANEL_ID} .unity-afp-line {
      margin: 0;
      padding: 6px 8px;
      border-radius: 8px;
      border: 1px solid var(--unity-afp-line-border);
      background: var(--unity-afp-line-bg);
      font-size: 12px;
      line-height: 1.35;
    }
    #${AUDIO_FOLLOW_PANEL_ID} .unity-afp-line[data-current="true"] {
      border-color: var(--unity-afp-current-border);
      background: var(--unity-afp-current-bg);
      box-shadow: 0 0 0 2px var(--unity-afp-current-shadow);
      border-left: 5px solid var(--unity-afp-current-border);
      padding-left: 7px;
      text-decoration: underline;
      text-underline-offset: 2px;
      font-weight: 700;
    }
    .unity-audio-page-follow-host {
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
      z-index: 2147483646;
      --unity-page-follow-current-fill: rgba(255, 223, 165, 0.28);
      --unity-page-follow-current-border: rgba(168, 102, 44, 0.94);
      --unity-page-follow-current-outline: rgba(168, 102, 44, 0.3);
      --unity-page-follow-context-fill: rgba(255, 240, 210, 0.12);
      --unity-page-follow-context-border: rgba(168, 102, 44, 0.42);
      --unity-page-follow-context-outline: rgba(168, 102, 44, 0.22);
    }
    .unity-audio-page-follow-host[data-surface="dark"] {
      --unity-page-follow-current-fill: rgba(255, 226, 175, 0.18);
      --unity-page-follow-current-border: rgba(255, 203, 122, 0.98);
      --unity-page-follow-current-outline: rgba(255, 203, 122, 0.34);
      --unity-page-follow-context-fill: rgba(255, 240, 210, 0.08);
      --unity-page-follow-context-border: rgba(255, 203, 122, 0.34);
      --unity-page-follow-context-outline: rgba(255, 203, 122, 0.2);
    }
    html[${PAGE_MODE_ATTR}="true"] .unity-audio-page-follow-host {
      --unity-page-follow-current-fill: rgba(199, 222, 255, 0.26);
      --unity-page-follow-current-border: rgba(0, 95, 204, 0.98);
      --unity-page-follow-current-outline: rgba(0, 95, 204, 0.28);
      --unity-page-follow-context-fill: rgba(214, 231, 255, 0.1);
      --unity-page-follow-context-border: rgba(0, 95, 204, 0.38);
      --unity-page-follow-context-outline: rgba(0, 95, 204, 0.2);
    }
    html[${PAGE_MODE_ATTR}="true"] .unity-audio-page-follow-host[data-surface="dark"] {
      --unity-page-follow-current-fill: rgba(180, 213, 255, 0.2);
      --unity-page-follow-current-border: rgba(143, 201, 255, 0.98);
      --unity-page-follow-current-outline: rgba(143, 201, 255, 0.35);
      --unity-page-follow-context-fill: rgba(214, 231, 255, 0.08);
      --unity-page-follow-context-border: rgba(143, 201, 255, 0.34);
      --unity-page-follow-context-outline: rgba(143, 201, 255, 0.2);
    }
    .unity-audio-page-follow-line {
      position: absolute;
      opacity: 0;
      border-radius: 7px;
      transition:
        top 180ms ease,
        left 180ms ease,
        width 180ms ease,
        height 180ms ease,
        opacity 180ms ease,
        box-shadow 180ms ease,
        border-color 180ms ease,
        background-color 180ms ease;
    }
    .unity-audio-page-follow-line[data-variant="current"] {
      border-left: 4px solid var(--unity-page-follow-current-border);
      background: var(--unity-page-follow-current-fill);
      box-shadow: 0 0 0 2px var(--unity-page-follow-current-outline);
      backdrop-filter: saturate(1.05);
    }
    .unity-audio-page-follow-line[data-variant="previous"],
    .unity-audio-page-follow-line[data-variant="next"] {
      border-left: 2px solid var(--unity-page-follow-context-border);
      background: var(--unity-page-follow-context-fill);
      box-shadow: 0 0 0 1px var(--unity-page-follow-context-outline);
    }
  `;
  document.documentElement.appendChild(style);
}

function installPageColorBlindStyles() {
  if (document.getElementById(PAGE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PAGE_STYLE_ID;
  style.textContent = `
    html[${PAGE_MODE_ATTR}="true"] {
      --unity-page-focus: #005fcc;
      --unity-page-focus-shadow: rgba(0, 95, 204, 0.3);
      --unity-page-selected: #0b5da8;
      --unity-page-error: #8d1f31;
      --unity-page-success: #1f5f3a;
      --unity-page-warning: #7a5400;
      --unity-page-selected-tint: rgba(11, 93, 168, 0.13);
      --unity-page-error-tint: rgba(141, 31, 49, 0.1);
      --unity-page-success-tint: rgba(31, 95, 58, 0.1);
      --unity-page-warning-tint: rgba(122, 84, 0, 0.1);
      --unity-page-link: #0a4f8f;
      --unity-page-link-visited: #5a3f88;
    }

    html[${PAGE_MODE_ATTR}="true"] a {
      color: var(--unity-page-link) !important;
      text-decoration-line: underline !important;
      text-decoration-thickness: max(2px, 0.11em) !important;
      text-underline-offset: 2px !important;
    }

    html[${PAGE_MODE_ATTR}="true"] a:visited {
      color: var(--unity-page-link-visited) !important;
      text-decoration-style: dotted !important;
    }

    html[${PAGE_MODE_ATTR}="true"] :is(
      button,
      [role="button"],
      a,
      input,
      select,
      textarea,
      summary,
      [tabindex]:not([tabindex="-1"])
    ):focus-visible {
      outline: 3px solid var(--unity-page-focus) !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 3px var(--unity-page-focus-shadow) !important;
    }

    html[${PAGE_MODE_ATTR}="true"] :is(
      button,
      [role="button"],
      [role="tab"],
      [role="option"],
      [role="menuitem"],
      [role="link"],
      a,
      summary,
      [tabindex]:not([tabindex="-1"])
    ):is(
      [aria-current="page"],
      [aria-selected="true"],
      [aria-pressed="true"],
      [aria-expanded="true"],
      [data-selected="true"],
      .is-active,
      .active,
      .selected,
      .current
    ) {
      box-shadow: inset 5px 0 0 var(--unity-page-selected) !important;
      outline: 2px solid var(--unity-page-selected) !important;
      outline-offset: 1px !important;
      background-image: linear-gradient(var(--unity-page-selected-tint), var(--unity-page-selected-tint)) !important;
    }

    html[${PAGE_MODE_ATTR}="true"] :is(
      [aria-invalid="true"],
      [data-status="error"],
      [data-state="error"],
      [role="alert"],
      [aria-live="assertive"],
      .error-message,
      .form-error,
      .field-error,
      .has-error,
      input.error,
      textarea.error,
      select.error,
      input.invalid,
      textarea.invalid,
      select.invalid
    ) {
      box-shadow: inset 5px 0 0 var(--unity-page-error) !important;
      background-image: repeating-linear-gradient(
        -45deg,
        var(--unity-page-error-tint) 0 8px,
        transparent 8px 16px
      ) !important;
    }

    html[${PAGE_MODE_ATTR}="true"] :is(
      [data-status="success"],
      [data-state="success"],
      .success-message,
      .form-success,
      .field-success,
      .valid,
      .ok,
      input.valid,
      textarea.valid,
      select.valid
    ) {
      box-shadow: inset 5px 0 0 var(--unity-page-success) !important;
      background-image: repeating-linear-gradient(
        45deg,
        var(--unity-page-success-tint) 0 8px,
        transparent 8px 16px
      ) !important;
    }

    html[${PAGE_MODE_ATTR}="true"] :is(
      [data-status="warning"],
      [data-state="warning"],
      [role="status"][data-status="warning"],
      .warning-message,
      .form-warning,
      .field-warning,
      .warning,
      .warn
    ) {
      box-shadow: inset 5px 0 0 var(--unity-page-warning) !important;
      background-image: repeating-linear-gradient(
        90deg,
        var(--unity-page-warning-tint) 0 6px,
        transparent 6px 12px
      ) !important;
    }
  `;
  document.documentElement.appendChild(style);
}

function installPageReducedMotionStyles() {
  if (document.getElementById(PAGE_REDUCED_MOTION_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PAGE_REDUCED_MOTION_STYLE_ID;
  style.textContent = `
    html[${PAGE_REDUCED_MOTION_ATTR}="true"] {
      scroll-behavior: auto !important;
    }

    html[${PAGE_REDUCED_MOTION_ATTR}="true"] *:not(
      [${MOTION_EXEMPT_ATTR}="true"],
      [${MOTION_EXEMPT_ATTR}="true"] *,
      [${UI_ATTR}="true"],
      [${UI_ATTR}="true"] *
    ),
    html[${PAGE_REDUCED_MOTION_ATTR}="true"] *:not(
      [${MOTION_EXEMPT_ATTR}="true"],
      [${MOTION_EXEMPT_ATTR}="true"] *,
      [${UI_ATTR}="true"],
      [${UI_ATTR}="true"] *
    )::before,
    html[${PAGE_REDUCED_MOTION_ATTR}="true"] *:not(
      [${MOTION_EXEMPT_ATTR}="true"],
      [${MOTION_EXEMPT_ATTR}="true"] *,
      [${UI_ATTR}="true"],
      [${UI_ATTR}="true"] *
    )::after {
      animation: none !important;
      animation-play-state: paused !important;
      transition: none !important;
      scroll-behavior: auto !important;
    }
  `;
  document.documentElement.appendChild(style);
}

function applyPageColorBlindMode(enabled: boolean) {
  if (enabled) {
    document.documentElement.setAttribute(PAGE_MODE_ATTR, 'true');
    return;
  }
  document.documentElement.removeAttribute(PAGE_MODE_ATTR);
}

function applyPageReducedMotionMode(enabled: boolean) {
  if (enabled) {
    document.documentElement.setAttribute(PAGE_REDUCED_MOTION_ATTR, 'true');
    return;
  }
  document.documentElement.removeAttribute(PAGE_REDUCED_MOTION_ATTR);
}

function getForcedFontFamily(forcedFont: ForcedFontOption): string | null {
  switch (forcedFont) {
    case 'opendyslexic':
      return '"Unity OpenDyslexic", "OpenDyslexic", "OpenDyslexic3", Arial, sans-serif';
    case 'arial':
      return 'Arial, sans-serif';
    case 'helvetica':
      return 'Helvetica, Arial, sans-serif';
    case 'verdana':
      return 'Verdana, Geneva, sans-serif';
    case 'comic-sans':
      return '"Comic Sans MS", "Comic Sans", "Chalkboard SE", "Comic Neue", cursive';
    case 'none':
    default:
      return null;
  }
}

function installForcedFontStyles() {
  if (document.getElementById(PAGE_FONT_STYLE_ID)) return;
  const openDyslexicRegularUrl = ext.runtime.getURL('/fonts/opendyslexic/OpenDyslexic-Regular.otf');
  const openDyslexicBoldUrl = ext.runtime.getURL('/fonts/opendyslexic/OpenDyslexic-Bold.otf');
  const openDyslexicItalicUrl = ext.runtime.getURL('/fonts/opendyslexic/OpenDyslexic-Italic.otf');
  const openDyslexicBoldItalicUrl = ext.runtime.getURL('/fonts/opendyslexic/OpenDyslexic-BoldItalic.otf');
  const style = document.createElement('style');
  style.id = PAGE_FONT_STYLE_ID;
  style.textContent = `
    @font-face {
      font-family: "Unity OpenDyslexic";
      src: url("${openDyslexicRegularUrl}") format("opentype");
      font-style: normal;
      font-weight: 400;
      font-display: swap;
    }

    @font-face {
      font-family: "Unity OpenDyslexic";
      src: url("${openDyslexicBoldUrl}") format("opentype");
      font-style: normal;
      font-weight: 700;
      font-display: swap;
    }

    @font-face {
      font-family: "Unity OpenDyslexic";
      src: url("${openDyslexicItalicUrl}") format("opentype");
      font-style: italic;
      font-weight: 400;
      font-display: swap;
    }

    @font-face {
      font-family: "Unity OpenDyslexic";
      src: url("${openDyslexicBoldItalicUrl}") format("opentype");
      font-style: italic;
      font-weight: 700;
      font-display: swap;
    }

    html[${PAGE_FONT_ATTR}="true"],
    html[${PAGE_FONT_ATTR}="true"] *,
    html[${PAGE_FONT_ATTR}="true"] *::before,
    html[${PAGE_FONT_ATTR}="true"] *::after {
      font-family: var(--unity-forced-font-family) !important;
    }

    html[${PAGE_FONT_ATTR}="true"] :is(input, textarea)::placeholder {
      font-family: var(--unity-forced-font-family) !important;
    }
  `;
  document.documentElement.appendChild(style);
}

function buildForcedFontShadowCss(fontFamily: string): string {
  return `
    :host,
    :host *,
    :host *::before,
    :host *::after {
      font-family: ${fontFamily} !important;
    }

    :host :is(input, textarea)::placeholder {
      font-family: ${fontFamily} !important;
    }
  `;
}

function applyForcedFontToShadowRoot(shadowRoot: ShadowRoot, fontFamily: string | null) {
  KNOWN_SHADOW_ROOTS.add(shadowRoot);
  const existingStyle = shadowRoot.querySelector<HTMLStyleElement>(
    `style[${SHADOW_FONT_STYLE_ATTR}="true"]`,
  );

  if (!fontFamily) {
    existingStyle?.remove();
    return;
  }

  const style = existingStyle ?? document.createElement('style');
  if (!existingStyle) {
    style.setAttribute(SHADOW_FONT_STYLE_ATTR, 'true');
    shadowRoot.prepend(style);
  }
  style.textContent = buildForcedFontShadowCss(fontFamily);
}

function syncKnownShadowRoots(fontFamily: string | null) {
  for (const shadowRoot of KNOWN_SHADOW_ROOTS) {
    const host = shadowRoot.host;
    if (!host?.isConnected) {
      KNOWN_SHADOW_ROOTS.delete(shadowRoot);
      continue;
    }
    applyForcedFontToShadowRoot(shadowRoot, fontFamily);
  }
}

function installAttachShadowHook() {
  const proto = Element.prototype as Element & {
    [ATTACH_SHADOW_HOOK_ATTR]?: true;
    attachShadow: (init: ShadowRootInit) => ShadowRoot;
  };
  if (proto[ATTACH_SHADOW_HOOK_ATTR]) return;
  const nativeAttachShadow = proto.attachShadow;
  proto.attachShadow = function patchedAttachShadow(this: Element, init: ShadowRootInit): ShadowRoot {
    const shadowRoot = nativeAttachShadow.call(this, init);
    KNOWN_SHADOW_ROOTS.add(shadowRoot);
    const activeFontFamily =
      document.documentElement.style.getPropertyValue('--unity-forced-font-family').trim() || null;
    applyForcedFontToShadowRoot(shadowRoot, activeFontFamily);
    return shadowRoot;
  };
  proto[ATTACH_SHADOW_HOOK_ATTR] = true;
}

function syncForcedFontInNode(node: ParentNode, fontFamily: string | null) {
  const elements = node.querySelectorAll<HTMLElement>('*');
  for (const element of elements) {
    const shadowRoot = element.shadowRoot;
    if (!shadowRoot) continue;
    applyForcedFontToShadowRoot(shadowRoot, fontFamily);
    syncForcedFontInNode(shadowRoot, fontFamily);
  }
}

function syncForcedFontInElementAndDescendants(element: Element, fontFamily: string | null) {
  const root = element as HTMLElement;
  if (root.shadowRoot) {
    applyForcedFontToShadowRoot(root.shadowRoot, fontFamily);
    syncForcedFontInNode(root.shadowRoot, fontFamily);
  }
  syncForcedFontInNode(element, fontFamily);
}

function applyForcedPageFont(forcedFont: ForcedFontOption) {
  const fontFamily = getForcedFontFamily(forcedFont);
  if (!fontFamily) {
    document.documentElement.removeAttribute(PAGE_FONT_ATTR);
    document.documentElement.style.removeProperty('--unity-forced-font-family');
    syncForcedFontInNode(document.documentElement, null);
    syncKnownShadowRoots(null);
    return;
  }

  document.documentElement.setAttribute(PAGE_FONT_ATTR, 'true');
  document.documentElement.style.setProperty('--unity-forced-font-family', fontFamily);
  syncForcedFontInNode(document.documentElement, fontFamily);
  syncKnownShadowRoots(fontFamily);
}

function isUiNode(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return Boolean(element?.closest(`[${UI_ATTR}="true"]`));
}

function getSelectionSnapshot(pointerAnchor: PointerAnchor | null): SelectionSnapshot | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  if (isUiNode(selection.anchorNode) || isUiNode(selection.focusNode)) return null;

  const rawText = selection.toString().replace(/\s+/g, ' ').trim();
  if (rawText.length < MIN_SELECTION_CHARS) return null;

  const range = selection.getRangeAt(0);
  if (!range || !range.getBoundingClientRect) return null;

  let rect = range.getBoundingClientRect();
  if ((rect.width <= 0 || rect.height <= 0) && range.getClientRects().length > 0) {
    rect = range.getClientRects()[0];
  }

  if (!Number.isFinite(rect.top) || !Number.isFinite(rect.left)) return null;
  if (rect.width <= 0 && rect.height <= 0) return null;

  const anchorElement =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (anchorElement?.closest('input,textarea,[contenteditable="true"]')) return null;

  const fallbackAnchorX = rect.left + rect.width / 2;
  const fallbackAnchorY = rect.bottom;
  const hasFreshPointerAnchor =
    pointerAnchor &&
    Date.now() - pointerAnchor.at <= POINTER_ANCHOR_MAX_AGE_MS &&
    Number.isFinite(pointerAnchor.x) &&
    Number.isFinite(pointerAnchor.y);

  return {
    text: rawText,
    rect,
    anchorX: hasFreshPointerAnchor ? pointerAnchor.x : fallbackAnchorX,
    anchorY: hasFreshPointerAnchor ? pointerAnchor.y : fallbackAnchorY,
  };
}

function setActionBarLevel(actionBar: HTMLElement, level: RewriteLevel) {
  const levelButtons = Array.from(actionBar.querySelectorAll<HTMLButtonElement>('[data-level]'));
  for (const button of levelButtons) {
    const isActive = button.dataset.level === String(level);
    button.dataset.active = String(isActive);
    button.setAttribute('aria-pressed', String(isActive));
  }
}

function createActionBar(
  initialLevel: RewriteLevel,
  onAction: (action: SelectionAction) => void,
  onLevelChange: (level: RewriteLevel) => void,
  colorBlindModeEnabled: boolean,
): HTMLElement {
  const root = document.createElement('div');
  root.id = ACTION_BAR_ID;
  root.setAttribute(UI_ATTR, 'true');
  root.setAttribute(MOTION_EXEMPT_ATTR, 'true');
  root.setAttribute('data-color-blind-mode', String(colorBlindModeEnabled));
  root.innerHTML = `
    <button type="button" class="cred-action-btn" data-action="simplify">${ACTION_CONFIG.simplify.label}</button>
    <button type="button" class="cred-action-btn" data-action="summarize">${ACTION_CONFIG.summarize.label}</button>
    <div class="cred-levels" aria-label="Reading level">
      ${REWRITE_LEVELS.map((level) => `<button type="button" class="cred-level-btn" data-level="${level}">${LEVEL_LABELS[level]}</button>`).join('')}
    </div>
  `;
  setActionBarLevel(root, initialLevel);
  root.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  root.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.target as HTMLElement | null;
    const action = target?.closest('button')?.getAttribute('data-action');
    if (action === 'simplify' || action === 'summarize') {
      onAction(action);
      return;
    }
    const levelText = target?.closest('button')?.getAttribute('data-level');
    const level = Number(levelText);
    if (level === 1 || level === 2 || level === 3) {
      onLevelChange(level);
      setActionBarLevel(root, level);
    }
  });
  return root;
}

function createCard(onClose: () => void, colorBlindModeEnabled: boolean): HTMLElement {
  const card = document.createElement('section');
  card.id = CARD_ID;
  card.setAttribute('data-state', 'idle');
  card.setAttribute(UI_ATTR, 'true');
  card.setAttribute(MOTION_EXEMPT_ATTR, 'true');
  card.setAttribute('data-color-blind-mode', String(colorBlindModeEnabled));
  card.innerHTML = `
    <div class="cred-selection-head">
      <span class="cred-selection-title"></span>
      <button type="button" class="cred-selection-close" aria-label="Close selection result">&times;</button>
    </div>
    <p class="cred-selection-body"></p>
  `;
  card.querySelector<HTMLButtonElement>('.cred-selection-close')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClose();
  });
  return card;
}

function positionNearSelection(element: HTMLElement, selection: SelectionSnapshot, gap = 10) {
  const margin = 8;
  const width = element.offsetWidth;
  const height = element.offsetHeight;

  const leftCandidate = selection.anchorX + gap;
  const leftFallback = selection.anchorX - width - gap;
  let left = leftCandidate;
  if (left + width > window.innerWidth - margin) {
    left = leftFallback;
  }
  left = clamp(left, margin, window.innerWidth - width - margin);

  const topCandidate = selection.anchorY + gap;
  const topFallback = selection.anchorY - height - gap;
  let top = topCandidate;
  if (top + height > window.innerHeight - margin) {
    top = topFallback;
  }
  top = clamp(top, margin, window.innerHeight - height - margin);

  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

async function sendActionRequest(
  action: SelectionAction,
  text: string,
  level: RewriteLevel,
): Promise<ActionResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const message: RuntimeRequest =
        action === 'simplify'
          ? { type: 'SIMPLIFY_TEXT', text, level }
          : { type: 'SUMMARIZE_TEXT', text, level };
      const response = (await ext.runtime.sendMessage(message)) as
        | { ok: boolean; simplified?: string; summary?: string; error?: string }
        | undefined;
      if (response) {
        return {
          ok: response.ok,
          result: action === 'simplify' ? response.simplified : response.summary,
          error: response.error,
        };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 120 + attempt * 120));
  }
  const messageText = lastError instanceof Error ? lastError.message : 'Background request failed.';
  return { ok: false, error: messageText };
}

export default defineContentScript({
  matches: ['*://*/*'],
  allFrames: true,
  matchAboutBlank: true,
  runAt: 'document_start',
  main() {
    installAttachShadowHook();
    installStyles();
    installPageColorBlindStyles();
    installPageReducedMotionStyles();
    installForcedFontStyles();

    let activeSelection: SelectionSnapshot | null = null;
    let actionBar: HTMLElement | null = null;
    let card: HTMLElement | null = null;
    let requestToken = 0;
    let selectedLevel: RewriteLevel = 2;
    let pointerSelectionInProgress = false;
    let lastPointerAnchor: PointerAnchor | null = null;
    let colorBlindModeEnabled = false;
    let reduceMotionEnabled = false;
    let forcedFont: ForcedFontOption = 'none';
    let audioRate = 1;
    let audioFollowModeEnabled = false;
    let audioCurrentText = '';
    let audioLines: string[] = [];
    let audioLineOffsets: number[] = [];
    let audioCurrentLineIndex = -1;
    let audioCurrentCharIndex = 0;
    let audioIsSpeaking = false;
    let audioIsPaused = false;
    let audioNeedsRestartOnResume = false;
    let audioUtterance: SpeechSynthesisUtterance | null = null;
    let audioSelectionRange: Range | null = null;
    let audioSelectionLineRects: SelectionLineRect[] = [];
    let audioSelectionLineWeightEnds: number[] = [];
    let audioSelectionLineWeightTotal = 0;
    let audioFollowPanel: HTMLElement | null = null;
    let audioFollowMeta: HTMLElement | null = null;
    let audioFollowLinesHost: HTMLElement | null = null;
    let audioPageHighlightHost: HTMLElement | null = null;
    let audioPageCurrentMarker: HTMLElement | null = null;
    let audioPagePrevMarker: HTMLElement | null = null;
    let audioPageNextMarker: HTMLElement | null = null;
    let audioCurrentPageLineIndex = -1;
    let audioLastPageLineChangeAt = 0;
    let audioLastAutoScrollAt = 0;
    let forcedFontObserver: MutationObserver | null = null;
    let reduceMotionGifObserver: MutationObserver | null = null;
    let forcedFontRescanInterval: number | null = null;
    let reduceMotionRescanInterval: number | null = null;
    let canvasPlaceholderCounter = 0;

    const applyColorBlindModeToUi = () => {
      if (actionBar) {
        actionBar.setAttribute('data-color-blind-mode', String(colorBlindModeEnabled));
      }
      if (card) {
        card.setAttribute('data-color-blind-mode', String(colorBlindModeEnabled));
      }
      if (audioFollowPanel) {
        audioFollowPanel.setAttribute('data-color-blind-mode', String(colorBlindModeEnabled));
      }
    };

    const ensureForcedFontObserver = () => {
      if (forcedFontObserver) return;
      forcedFontObserver = new MutationObserver((mutations) => {
        const fontFamily = getForcedFontFamily(forcedFont);
        if (!fontFamily) return;

        for (const mutation of mutations) {
          for (const addedNode of mutation.addedNodes) {
            if (!(addedNode instanceof Element)) continue;
            syncForcedFontInElementAndDescendants(addedNode, fontFamily);
          }
        }
      });
      forcedFontObserver.observe(document.documentElement, { childList: true, subtree: true });
    };

    const runForcedFontRescan = () => {
      const fontFamily = getForcedFontFamily(forcedFont);
      if (!fontFamily) return;
      syncForcedFontInNode(document.documentElement, fontFamily);
      syncKnownShadowRoots(fontFamily);
    };

    const startForcedFontRescanLoop = () => {
      if (forcedFontRescanInterval !== null) return;
      runForcedFontRescan();
      forcedFontRescanInterval = window.setInterval(runForcedFontRescan, 1500);
    };

    const stopForcedFontRescanLoop = () => {
      if (forcedFontRescanInterval === null) return;
      window.clearInterval(forcedFontRescanInterval);
      forcedFontRescanInterval = null;
    };

    const syncForcedFontRescanLoop = () => {
      if (getForcedFontFamily(forcedFont)) {
        startForcedFontRescanLoop();
        return;
      }
      stopForcedFontRescanLoop();
    };

    const isMotionExemptNode = (node: Node | null): boolean => {
      const element = node instanceof Element ? node : node?.parentElement ?? null;
      return Boolean(element?.closest(`[${MOTION_EXEMPT_ATTR}="true"],[${UI_ATTR}="true"]`));
    };

    const setAttributeNullable = (element: Element, name: string, value: string | null) => {
      if (value === null) {
        element.removeAttribute(name);
        return;
      }
      element.setAttribute(name, value);
    };

    type FrozenImageState = {
      src: string | null;
      srcset: string | null;
      sizes: string | null;
      inlineVisibility: string;
      pictureSources?: Array<{ srcset: string | null; sizes: string | null }>;
    };

    const isGifUrl = (value: string | null | undefined): boolean => {
      if (!value) return false;
      const trimmed = value.trim();
      if (!trimmed) return false;
      if (/^data:image\/gif/i.test(trimmed)) return true;
      return /\.gif(?:[?#].*)?$/i.test(trimmed);
    };

    const isLikelyAnimatedImageUrl = (value: string | null | undefined): boolean => {
      if (!value) return false;
      const trimmed = value.trim();
      if (!trimmed) return false;
      if (isGifUrl(trimmed)) return true;
      return /\/\/media\d*\.giphy\.com\/media\/.+\.webp(?:[?#].*)?$/i.test(trimmed);
    };

    const srcsetContainsAnimatedCandidate = (srcset: string | null): boolean => {
      if (!srcset) return false;
      const candidates = srcset
        .split(',')
        .map((item) => item.trim().split(/\s+/)[0])
        .filter(Boolean);
      for (const candidate of candidates) {
        if (isLikelyAnimatedImageUrl(candidate)) return true;
      }
      return false;
    };

    const isGifImage = (image: HTMLImageElement): boolean => {
      if (isLikelyAnimatedImageUrl(image.currentSrc)) return true;
      if (isLikelyAnimatedImageUrl(image.getAttribute('src'))) return true;
      if (isLikelyAnimatedImageUrl(image.src)) return true;
      if (srcsetContainsAnimatedCandidate(image.getAttribute('srcset'))) return true;
      const picture = image.closest('picture');
      if (picture) {
        const sources = Array.from(picture.querySelectorAll<HTMLSourceElement>('source'));
        for (const source of sources) {
          if (srcsetContainsAnimatedCandidate(source.getAttribute('srcset'))) {
            return true;
          }
        }
      }
      return false;
    };

    const buildFrozenImageState = (image: HTMLImageElement): FrozenImageState => {
      const picture = image.closest('picture');
      const pictureSources =
        picture
          ? Array.from(picture.querySelectorAll<HTMLSourceElement>('source')).map((source) => ({
              srcset: source.getAttribute('srcset'),
              sizes: source.getAttribute('sizes'),
            }))
          : undefined;

      return {
        src: image.getAttribute('src'),
        srcset: image.getAttribute('srcset'),
        sizes: image.getAttribute('sizes'),
        inlineVisibility: image.style.visibility,
        pictureSources,
      };
    };

    const getImageSourceStateKey = (image: HTMLImageElement): string =>
      JSON.stringify({
        srcAttr: image.getAttribute('src') ?? '',
        srcsetAttr: image.getAttribute('srcset') ?? '',
        currentSrc: image.currentSrc ?? '',
      });

    const freezeImageSourceSelection = (image: HTMLImageElement) => {
      const picture = image.closest('picture');
      if (picture) {
        const sources = Array.from(picture.querySelectorAll<HTMLSourceElement>('source'));
        for (const source of sources) {
          source.removeAttribute('srcset');
          source.removeAttribute('sizes');
        }
      }
      image.removeAttribute('srcset');
      image.removeAttribute('sizes');
    };

    const restoreGifImage = (image: HTMLImageElement) => {
      const serialized = image.getAttribute(GIF_ORIGINAL_ATTR);
      if (!serialized) {
        image.removeAttribute(GIF_FROZEN_ATTR);
        image.removeAttribute(GIF_FROZEN_SRC_ATTR);
        image.removeAttribute(GIF_PENDING_ATTR);
        return;
      }

      try {
        const original = JSON.parse(serialized) as {
          src: string | null;
          srcset: string | null;
          sizes: string | null;
          inlineVisibility?: string;
          pictureSources?: Array<{ srcset: string | null; sizes: string | null }>;
        };
        const picture = image.closest('picture');
        if (picture && Array.isArray(original.pictureSources)) {
          const sources = Array.from(picture.querySelectorAll<HTMLSourceElement>('source'));
          for (let index = 0; index < sources.length; index += 1) {
            const source = sources[index];
            const values = original.pictureSources[index] ?? { srcset: null, sizes: null };
            setAttributeNullable(source, 'srcset', values.srcset);
            setAttributeNullable(source, 'sizes', values.sizes);
          }
        }
        setAttributeNullable(image, 'srcset', original.srcset);
        setAttributeNullable(image, 'sizes', original.sizes);
        setAttributeNullable(image, 'src', original.src);
        image.style.visibility = original.inlineVisibility ?? '';
      } catch {
        // Ignore malformed saved payloads.
      } finally {
        image.removeAttribute(GIF_ORIGINAL_ATTR);
        image.removeAttribute(GIF_FROZEN_ATTR);
        image.removeAttribute(GIF_FROZEN_SRC_ATTR);
        image.removeAttribute(GIF_PENDING_ATTR);
      }
    };

    const extractSrcsetUrls = (srcset: string | null): string[] => {
      if (!srcset) return [];
      return srcset
        .split(',')
        .map((item) => item.trim().split(/\s+/)[0])
        .filter(Boolean);
    };

    const appendStillUrlCandidates = (sourceUrl: string, targets: Set<string>) => {
      const value = sourceUrl.trim();
      if (!value || /^data:/i.test(value)) return;

      const addIfChanged = (candidate: string) => {
        if (candidate && candidate !== value) targets.add(candidate);
      };

      if (/\.gif(?:[?#].*)?$/i.test(value)) {
        addIfChanged(value.replace(/\.gif(?:([?#].*)?)$/i, '_s.gif$1'));
      }
      if (/\.webp(?:[?#].*)?$/i.test(value)) {
        addIfChanged(value.replace(/\.webp(?:([?#].*)?)$/i, '_s.webp$1'));
        addIfChanged(value.replace(/\.webp(?:([?#].*)?)$/i, '_s.gif$1'));
      }
      addIfChanged(value.replace(/\/giphy\.webp(?:([?#].*)?)$/i, '/giphy_s.gif$1'));
      addIfChanged(value.replace(/\/giphy\.gif(?:([?#].*)?)$/i, '/giphy_s.gif$1'));
      addIfChanged(value.replace(/\/200\.webp(?:([?#].*)?)$/i, '/200_s.gif$1'));
      addIfChanged(value.replace(/\/200\.gif(?:([?#].*)?)$/i, '/200_s.gif$1'));
      addIfChanged(value.replace(/\/200w\.webp(?:([?#].*)?)$/i, '/200w_s.gif$1'));
      addIfChanged(value.replace(/\/200w\.gif(?:([?#].*)?)$/i, '/200w_s.gif$1'));
    };

    const buildStillImageCandidates = (image: HTMLImageElement): string[] => {
      const urls = new Set<string>();
      const directCandidates = [
        image.currentSrc,
        image.src,
        image.getAttribute('src'),
      ];
      for (const candidate of directCandidates) {
        if (candidate) appendStillUrlCandidates(candidate, urls);
      }

      const srcsetCandidates = [
        ...extractSrcsetUrls(image.getAttribute('srcset')),
      ];
      const picture = image.closest('picture');
      if (picture) {
        const sources = Array.from(picture.querySelectorAll<HTMLSourceElement>('source'));
        for (const source of sources) {
          srcsetCandidates.push(...extractSrcsetUrls(source.getAttribute('srcset')));
        }
      }
      for (const srcsetCandidate of srcsetCandidates) {
        appendStillUrlCandidates(srcsetCandidate, urls);
      }

      return Array.from(urls);
    };

    const resolveStillImageCandidate = async (candidates: string[]): Promise<string | null> => {
      for (const candidate of candidates) {
        const ok = await new Promise<boolean>((resolve) => {
          const probe = new Image();
          probe.onload = () => resolve(true);
          probe.onerror = () => resolve(false);
          probe.src = candidate;
        });
        if (ok) return candidate;
      }
      return null;
    };

    const applyStillUrlFallback = (image: HTMLImageElement, original: FrozenImageState): boolean => {
      const candidates = buildStillImageCandidates(image);
      if (candidates.length === 0) return false;
      image.setAttribute(GIF_PENDING_ATTR, 'true');

      void resolveStillImageCandidate(candidates)
        .then((candidate) => {
          if (!reduceMotionEnabled || !image.isConnected || isMotionExemptNode(image)) {
            image.removeAttribute(GIF_PENDING_ATTR);
            return;
          }
          if (!candidate) {
            image.removeAttribute(GIF_PENDING_ATTR);
            return;
          }

          image.setAttribute(GIF_ORIGINAL_ATTR, JSON.stringify(original));
          image.setAttribute(GIF_FROZEN_SRC_ATTR, GIF_FROZEN_PENDING_SRC);
          freezeImageSourceSelection(image);
          image.src = candidate;
          image.setAttribute(GIF_FROZEN_ATTR, 'true');
          image.setAttribute(GIF_FROZEN_SRC_ATTR, getImageSourceStateKey(image));
          image.removeAttribute(GIF_PENDING_ATTR);
        })
        .catch(() => {
          image.removeAttribute(GIF_PENDING_ATTR);
        });
      return true;
    };

    const freezeGifImage = (image: HTMLImageElement) => {
      if (isMotionExemptNode(image)) return;
      if (!isGifImage(image)) return;
      if (image.getAttribute(GIF_FROZEN_ATTR) === 'true') {
        const expectedFrozenSrc = image.getAttribute(GIF_FROZEN_SRC_ATTR);
        const currentSrc = getImageSourceStateKey(image);
        if (!expectedFrozenSrc || expectedFrozenSrc === GIF_FROZEN_PENDING_SRC) return;
        if (expectedFrozenSrc && currentSrc === expectedFrozenSrc) return;
        // Virtualized lists can recycle nodes and rewrite src/srcset while keeping custom attrs.
        image.removeAttribute(GIF_ORIGINAL_ATTR);
        image.removeAttribute(GIF_FROZEN_ATTR);
        image.removeAttribute(GIF_FROZEN_SRC_ATTR);
      }
      if (image.getAttribute(GIF_PENDING_ATTR) === 'true') {
        if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
          return;
        }
        image.removeAttribute(GIF_PENDING_ATTR);
      }

      if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        image.setAttribute(GIF_PENDING_ATTR, 'true');
        image.addEventListener(
          'load',
          () => {
            image.removeAttribute(GIF_PENDING_ATTR);
            if (!reduceMotionEnabled) return;
            freezeGifImage(image);
          },
          { once: true },
        );
        return;
      }

      const original = buildFrozenImageState(image);
      let frozenSrc: string | null = null;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, image.naturalWidth);
        canvas.height = Math.max(1, image.naturalHeight);
        const context = canvas.getContext('2d');
        if (!context) return;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        frozenSrc = canvas.toDataURL('image/png');
      } catch {
        frozenSrc = null;
      }

      if (!frozenSrc) {
        void applyStillUrlFallback(image, original);
        return;
      }

      image.setAttribute(GIF_ORIGINAL_ATTR, JSON.stringify(original));
      image.setAttribute(GIF_FROZEN_ATTR, 'true');
      image.setAttribute(GIF_FROZEN_SRC_ATTR, GIF_FROZEN_PENDING_SRC);
      image.removeAttribute(GIF_PENDING_ATTR);
      freezeImageSourceSelection(image);
      image.src = frozenSrc;
      image.setAttribute(GIF_FROZEN_SRC_ATTR, getImageSourceStateKey(image));
    };

    const freezeGifImagesInNode = (node: Node) => {
      if (node instanceof HTMLImageElement) {
        freezeGifImage(node);
      }
      if (node instanceof HTMLSourceElement) {
        const picture = node.closest('picture');
        const image = picture?.querySelector<HTMLImageElement>('img');
        if (image) {
          freezeGifImage(image);
        }
      }
      if (!(node instanceof Element || node instanceof Document || node instanceof DocumentFragment)) {
        return;
      }
      const root = node as ParentNode;
      const images = Array.from(root.querySelectorAll<HTMLImageElement>('img'));
      for (const image of images) {
        freezeGifImage(image);
      }
    };

    const freezeAllGifImages = () => {
      freezeGifImagesInNode(document.documentElement);
    };

    const unfreezeAllGifImages = () => {
      const images = Array.from(document.querySelectorAll<HTMLImageElement>(`img[${GIF_FROZEN_ATTR}="true"]`));
      for (const image of images) {
        restoreGifImage(image);
      }
      const pendingImages = Array.from(document.querySelectorAll<HTMLImageElement>(`img[${GIF_PENDING_ATTR}="true"]`));
      for (const image of pendingImages) {
        image.removeAttribute(GIF_PENDING_ATTR);
      }
    };

    const freezeCanvasElement = (canvas: HTMLCanvasElement) => {
      if (isMotionExemptNode(canvas)) return;
      if (canvas.getAttribute(CANVAS_FROZEN_ATTR) === 'true') return;

      const originalVisibility = canvas.style.visibility;
      canvas.setAttribute(CANVAS_ORIGINAL_VISIBILITY_ATTR, originalVisibility);
      canvas.setAttribute(CANVAS_FROZEN_ATTR, 'true');

      let snapshot: string | null = null;
      try {
        snapshot = canvas.toDataURL('image/png');
      } catch {
        snapshot = null;
      }

      if (snapshot) {
        const placeholder = document.createElement('img');
        const placeholderId = `${CANVAS_PLACEHOLDER_ID_PREFIX}${canvasPlaceholderCounter + 1}`;
        canvasPlaceholderCounter += 1;
        placeholder.id = placeholderId;
        placeholder.alt = '';
        placeholder.src = snapshot;
        placeholder.setAttribute(CANVAS_PLACEHOLDER_ATTR, 'true');
        placeholder.setAttribute(MOTION_EXEMPT_ATTR, 'true');
        if (canvas.className) {
          placeholder.className = canvas.className;
        }
        const inlineStyle = canvas.getAttribute('style');
        if (inlineStyle) {
          placeholder.setAttribute('style', inlineStyle);
        }
        if (!placeholder.style.width && canvas.clientWidth > 0) {
          placeholder.style.width = `${canvas.clientWidth}px`;
        }
        if (!placeholder.style.height && canvas.clientHeight > 0) {
          placeholder.style.height = `${canvas.clientHeight}px`;
        }
        placeholder.style.pointerEvents = 'none';
        canvas.insertAdjacentElement('afterend', placeholder);
        canvas.setAttribute(CANVAS_PLACEHOLDER_ID_ATTR, placeholderId);
      }

      canvas.style.visibility = 'hidden';
    };

    const unfreezeCanvasElement = (canvas: HTMLCanvasElement) => {
      const placeholderId = canvas.getAttribute(CANVAS_PLACEHOLDER_ID_ATTR);
      if (placeholderId) {
        document.getElementById(placeholderId)?.remove();
      }
      const originalVisibility = canvas.getAttribute(CANVAS_ORIGINAL_VISIBILITY_ATTR);
      canvas.style.visibility = originalVisibility ?? '';
      canvas.removeAttribute(CANVAS_FROZEN_ATTR);
      canvas.removeAttribute(CANVAS_ORIGINAL_VISIBILITY_ATTR);
      canvas.removeAttribute(CANVAS_PLACEHOLDER_ID_ATTR);
    };

    const freezeCanvasesInNode = (node: Node) => {
      if (node instanceof HTMLCanvasElement) {
        freezeCanvasElement(node);
      }
      if (!(node instanceof Element || node instanceof Document || node instanceof DocumentFragment)) {
        return;
      }
      const root = node as ParentNode;
      const canvases = Array.from(root.querySelectorAll<HTMLCanvasElement>('canvas'));
      for (const canvas of canvases) {
        freezeCanvasElement(canvas);
      }
    };

    const freezeAllCanvases = () => {
      freezeCanvasesInNode(document.documentElement);
    };

    const unfreezeAllCanvases = () => {
      const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>(`canvas[${CANVAS_FROZEN_ATTR}="true"]`));
      for (const canvas of canvases) {
        unfreezeCanvasElement(canvas);
      }
      const placeholders = Array.from(document.querySelectorAll<HTMLElement>(`[${CANVAS_PLACEHOLDER_ATTR}="true"]`));
      for (const placeholder of placeholders) {
        placeholder.remove();
      }
    };

    const startGifFreezeObserver = () => {
      if (reduceMotionGifObserver) return;
      reduceMotionGifObserver = new MutationObserver((mutations) => {
        if (!reduceMotionEnabled) return;
        for (const mutation of mutations) {
          if (mutation.type === 'attributes' && mutation.target instanceof HTMLImageElement) {
            freezeGifImage(mutation.target);
            continue;
          }
          if (mutation.type === 'attributes' && mutation.target instanceof HTMLSourceElement) {
            const picture = mutation.target.closest('picture');
            const image = picture?.querySelector<HTMLImageElement>('img');
            if (image) {
              freezeGifImage(image);
            }
            continue;
          }
          if (mutation.type === 'childList') {
            for (const addedNode of mutation.addedNodes) {
              freezeGifImagesInNode(addedNode);
              freezeCanvasesInNode(addedNode);
            }
          }
        }
      });
      reduceMotionGifObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset'],
      });
    };

    const stopGifFreezeObserver = () => {
      reduceMotionGifObserver?.disconnect();
      reduceMotionGifObserver = null;
    };

    const runReduceMotionRescan = () => {
      if (!reduceMotionEnabled) return;
      freezeAllGifImages();
      freezeAllCanvases();
    };

    const startReduceMotionRescanLoop = () => {
      if (reduceMotionRescanInterval !== null) return;
      runReduceMotionRescan();
      reduceMotionRescanInterval = window.setInterval(runReduceMotionRescan, REDUCE_MOTION_RESCAN_INTERVAL_MS);
    };

    const stopReduceMotionRescanLoop = () => {
      if (reduceMotionRescanInterval === null) return;
      window.clearInterval(reduceMotionRescanInterval);
      reduceMotionRescanInterval = null;
    };

    const applyReducedMotion = (enabled: boolean) => {
      reduceMotionEnabled = enabled;
      applyPageReducedMotionMode(enabled);
      if (!enabled) {
        stopGifFreezeObserver();
        stopReduceMotionRescanLoop();
        unfreezeAllGifImages();
        unfreezeAllCanvases();
        return;
      }
      startGifFreezeObserver();
      startReduceMotionRescanLoop();
      freezeAllGifImages();
      freezeAllCanvases();
    };

    const getSpeechEngine = (): SpeechSynthesis | null => {
      const maybe = window.speechSynthesis;
      return maybe && typeof maybe.speak === 'function' ? maybe : null;
    };

    const getCurrentSelectionText = (): string => {
      const value = window.getSelection()?.toString() ?? '';
      return value.replace(/\s+/g, ' ').trim();
    };

    const getCurrentSelectionSnapshot = (): { text: string; range: Range } | null => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
      const range = selection.getRangeAt(0).cloneRange();
      const text = selection.toString().replace(/\s+/g, ' ').trim();
      if (!text) return null;
      return { text, range };
    };

    const buildSelectionLineRects = (range: Range): SelectionLineRect[] => {
      const rawRects = Array.from(range.getClientRects())
        .filter((rect) => rect.width >= 4 && rect.height >= 6)
        .map((rect) => ({
          top: rect.top + window.scrollY,
          left: rect.left + window.scrollX,
          width: rect.width,
          height: rect.height,
        }))
        .sort((left, right) => (left.top === right.top ? left.left - right.left : left.top - right.top));

      const merged: SelectionLineRect[] = [];
      const rowThreshold = 4;
      for (const rect of rawRects) {
        const last = merged[merged.length - 1];
        if (!last || Math.abs(last.top - rect.top) > rowThreshold) {
          merged.push(rect);
          continue;
        }
        const top = Math.min(last.top, rect.top);
        const left = Math.min(last.left, rect.left);
        const right = Math.max(last.left + last.width, rect.left + rect.width);
        const bottom = Math.max(last.top + last.height, rect.top + rect.height);
        last.top = top;
        last.left = left;
        last.width = right - left;
        last.height = bottom - top;
      }
      return merged;
    };

    const recomputeSelectionLineWeights = () => {
      if (audioSelectionLineRects.length === 0) {
        audioSelectionLineWeightEnds = [];
        audioSelectionLineWeightTotal = 0;
        return;
      }
      const cumulative: number[] = [];
      let total = 0;
      for (const rect of audioSelectionLineRects) {
        const weight = Math.max(1, rect.width * Math.max(1, rect.height));
        total += weight;
        cumulative.push(total);
      }
      audioSelectionLineWeightEnds = cumulative;
      audioSelectionLineWeightTotal = total;
    };

    const clearPageHighlights = () => {
      audioCurrentPageLineIndex = -1;
      audioLastPageLineChangeAt = 0;
      audioPageCurrentMarker = null;
      audioPagePrevMarker = null;
      audioPageNextMarker = null;
      audioPageHighlightHost?.remove();
      audioPageHighlightHost = null;
    };

    const syncPageHighlightHostBounds = () => {
      if (!audioPageHighlightHost) return;
      const rootWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
        window.innerWidth,
      );
      const rootHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
        window.innerHeight,
      );
      audioPageHighlightHost.style.width = `${rootWidth}px`;
      audioPageHighlightHost.style.height = `${rootHeight}px`;
    };

    const ensurePageHighlightHost = () => {
      if (audioPageHighlightHost) {
        syncPageHighlightHostBounds();
        return;
      }
      const root = document.createElement('div');
      root.className = 'unity-audio-page-follow-host';
      root.setAttribute(UI_ATTR, 'true');
      root.setAttribute(MOTION_EXEMPT_ATTR, 'true');
      root.innerHTML = `
        <div class="unity-audio-page-follow-line" data-variant="previous"></div>
        <div class="unity-audio-page-follow-line" data-variant="current"></div>
        <div class="unity-audio-page-follow-line" data-variant="next"></div>
      `;
      document.documentElement.appendChild(root);
      audioPageHighlightHost = root;
      syncPageHighlightHostBounds();
      audioPagePrevMarker = root.querySelector<HTMLElement>('.unity-audio-page-follow-line[data-variant="previous"]');
      audioPageCurrentMarker = root.querySelector<HTMLElement>('.unity-audio-page-follow-line[data-variant="current"]');
      audioPageNextMarker = root.querySelector<HTMLElement>('.unity-audio-page-follow-line[data-variant="next"]');
    };

    const parseRgbChannels = (value: string): [number, number, number, number] | null => {
      const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i);
      if (!rgbMatch) return null;
      const parts = rgbMatch[1]
        .split(',')
        .map((part) => part.trim())
        .map((part) => Number(part));
      if (parts.length < 3 || parts.some((part, index) => index < 3 && !Number.isFinite(part))) return null;
      const alpha = parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : 1;
      return [parts[0], parts[1], parts[2], alpha];
    };

    const resolveSurfaceTone = (rect: SelectionLineRect): 'light' | 'dark' => {
      const viewportX = clamp(rect.left + rect.width / 2 - window.scrollX, 0, Math.max(0, window.innerWidth - 1));
      const viewportY = clamp(rect.top + rect.height / 2 - window.scrollY, 0, Math.max(0, window.innerHeight - 1));
      let cursor: Element | null =
        document.elementFromPoint(Math.round(viewportX), Math.round(viewportY));

      while (cursor) {
        const parsed = parseRgbChannels(window.getComputedStyle(cursor).backgroundColor);
        if (parsed && parsed[3] > 0.05) {
          const [red, green, blue] = parsed;
          const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
          return luminance < 0.46 ? 'dark' : 'light';
        }
        cursor = cursor.parentElement;
      }

      return 'light';
    };

    const setPageMarkerRect = (
      marker: HTMLElement | null,
      rect: SelectionLineRect | null,
      options?: { insetX?: number; insetY?: number; opacity?: number },
    ) => {
      if (!marker) return;
      if (!rect) {
        marker.style.opacity = '0';
        return;
      }
      const insetX = options?.insetX ?? 0;
      const insetY = options?.insetY ?? 0;
      const width = Math.max(2, rect.width + insetX * 2);
      const height = Math.max(2, rect.height + insetY * 2);
      marker.style.top = `${rect.top - insetY}px`;
      marker.style.left = `${rect.left - insetX}px`;
      marker.style.width = `${width}px`;
      marker.style.height = `${height}px`;
      marker.style.opacity = String(options?.opacity ?? 1);
    };

    const renderPageHighlights = () => {
      if (!audioFollowModeEnabled || audioSelectionLineRects.length === 0) {
        clearPageHighlights();
        return;
      }
      ensurePageHighlightHost();
      setPageMarkerRect(audioPagePrevMarker, null);
      setPageMarkerRect(audioPageCurrentMarker, null);
      setPageMarkerRect(audioPageNextMarker, null);
    };

    const setCurrentPageLineHighlight = (lineIndex: number, force = false) => {
      if (!audioFollowModeEnabled || audioSelectionLineRects.length === 0) return;
      const clamped =
        lineIndex < 0 || lineIndex >= audioSelectionLineRects.length
          ? -1
          : lineIndex;
      const changed = clamped !== audioCurrentPageLineIndex;
      audioCurrentPageLineIndex = clamped;
      ensurePageHighlightHost();

      if (clamped < 0) {
        setPageMarkerRect(audioPagePrevMarker, null);
        setPageMarkerRect(audioPageCurrentMarker, null);
        setPageMarkerRect(audioPageNextMarker, null);
        return;
      }

      const currentRect = audioSelectionLineRects[clamped];
      const previousRect = clamped > 0 ? audioSelectionLineRects[clamped - 1] : null;
      const nextRect = clamped + 1 < audioSelectionLineRects.length ? audioSelectionLineRects[clamped + 1] : null;

      if (audioPageHighlightHost) {
        audioPageHighlightHost.dataset.surface = resolveSurfaceTone(currentRect);
      }

      setPageMarkerRect(audioPageCurrentMarker, currentRect, { insetX: 4, insetY: 2, opacity: 1 });
      setPageMarkerRect(audioPagePrevMarker, previousRect, { insetX: 2, insetY: 1, opacity: 0.65 });
      setPageMarkerRect(audioPageNextMarker, nextRect, { insetX: 2, insetY: 1, opacity: 0.65 });

      if (!(changed || force)) return;
      const now = Date.now();
      if (changed) {
        audioLastPageLineChangeAt = now;
      }
      if (now - audioLastAutoScrollAt < 230) return;
      audioLastAutoScrollAt = now;
      const targetTop = Math.max(0, currentRect.top + currentRect.height / 2 - window.innerHeight / 2);
      window.scrollTo({ top: targetTop, behavior: 'smooth' });
    };

    const updateCurrentPageLineFromCharIndex = (charIndex: number) => {
      if (!audioFollowModeEnabled || audioSelectionLineRects.length === 0 || audioCurrentText.length === 0) return;
      const rawProgress = clamp(charIndex / Math.max(1, audioCurrentText.length), 0, 0.999999);
      const progress = clamp(rawProgress - AUDIO_PAGE_FOLLOW_PROGRESS_LAG, 0, 0.999999);
      let lineIndex: number;
      if (audioSelectionLineWeightEnds.length === audioSelectionLineRects.length && audioSelectionLineWeightTotal > 0) {
        const target = progress * audioSelectionLineWeightTotal;
        let resolved = audioSelectionLineWeightEnds.findIndex((end) => target <= end);
        if (resolved < 0) {
          resolved = audioSelectionLineWeightEnds.length - 1;
        }
        lineIndex = resolved;
      } else {
        lineIndex = clamp(Math.floor(progress * audioSelectionLineRects.length), 0, audioSelectionLineRects.length - 1);
      }
      if (
        audioCurrentPageLineIndex >= 0 &&
        lineIndex > audioCurrentPageLineIndex &&
        audioSelectionLineWeightEnds.length === audioSelectionLineRects.length &&
        audioSelectionLineWeightTotal > 0
      ) {
        const now = Date.now();
        if (now - audioLastPageLineChangeAt < AUDIO_PAGE_FOLLOW_MIN_ADVANCE_MS) {
          lineIndex = audioCurrentPageLineIndex;
        }
        const currentEnd = audioSelectionLineWeightEnds[audioCurrentPageLineIndex];
        const currentStart =
          audioCurrentPageLineIndex === 0 ? 0 : audioSelectionLineWeightEnds[audioCurrentPageLineIndex - 1];
        const currentWeight = Math.max(1, currentEnd - currentStart);
        const rawTarget = rawProgress * audioSelectionLineWeightTotal;
        const holdUntil = currentEnd + currentWeight * AUDIO_PAGE_FOLLOW_LINE_ADVANCE_HYSTERESIS;
        if (rawTarget < holdUntil) {
          lineIndex = audioCurrentPageLineIndex;
        }
      }
      setCurrentPageLineHighlight(lineIndex);
    };

    const splitTranscriptLines = (text: string): { lines: string[]; offsets: number[] } => {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (!normalized) return { lines: [], offsets: [] };
      const candidateLines = normalized
        .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
        .map((item) => item.trim())
        .filter(Boolean);
      const lines = candidateLines.length > 0 ? candidateLines : [normalized];
      const offsets: number[] = [];
      let cursor = 0;
      for (const line of lines) {
        offsets.push(cursor);
        cursor += line.length + 1;
      }
      return { lines, offsets };
    };

    const resolveLineIndexFromChar = (charIndex: number): number => {
      if (audioLines.length === 0) return -1;
      for (let index = audioLineOffsets.length - 1; index >= 0; index -= 1) {
        if (charIndex >= audioLineOffsets[index]) return index;
      }
      return 0;
    };

    const removeAudioFollowPanel = () => {
      audioFollowPanel?.remove();
      audioFollowPanel = null;
      audioFollowMeta = null;
      audioFollowLinesHost = null;
    };

    const ensureAudioFollowPanel = () => {
      if (!audioFollowModeEnabled || audioLines.length === 0) {
        removeAudioFollowPanel();
        return;
      }
      if (!audioFollowPanel) {
        const root = document.createElement('section');
        root.id = AUDIO_FOLLOW_PANEL_ID;
        root.setAttribute(UI_ATTR, 'true');
        root.setAttribute(MOTION_EXEMPT_ATTR, 'true');
        root.setAttribute('data-color-blind-mode', String(colorBlindModeEnabled));
        root.innerHTML = `
          <div class="unity-afp-head">
            <p class="unity-afp-title">Audio Follow</p>
            <p class="unity-afp-meta"></p>
          </div>
          <div class="unity-afp-lines"></div>
        `;
        document.documentElement.appendChild(root);
        audioFollowPanel = root;
        audioFollowMeta = root.querySelector<HTMLElement>('.unity-afp-meta');
        audioFollowLinesHost = root.querySelector<HTMLElement>('.unity-afp-lines');
      }
      applyColorBlindModeToUi();
    };

    const renderAudioFollowLines = () => {
      ensureAudioFollowPanel();
      if (!audioFollowLinesHost) return;
      audioFollowLinesHost.innerHTML = '';
      for (let index = 0; index < audioLines.length; index += 1) {
        const row = document.createElement('p');
        row.className = 'unity-afp-line';
        row.dataset.index = String(index);
        row.dataset.current = String(index === audioCurrentLineIndex);
        row.textContent = audioLines[index];
        audioFollowLinesHost.appendChild(row);
      }
    };

    const updateAudioFollowMeta = () => {
      if (!audioFollowMeta) return;
      if (audioLines.length === 0) {
        audioFollowMeta.textContent = 'No transcript';
        return;
      }
      const current = audioCurrentLineIndex >= 0 ? audioCurrentLineIndex + 1 : 0;
      audioFollowMeta.textContent = `Line ${current}/${audioLines.length}`;
    };

    const updateAudioLineHighlight = (lineIndex: number) => {
      audioCurrentLineIndex = lineIndex;
      if (!audioFollowLinesHost) return;
      const rows = Array.from(audioFollowLinesHost.querySelectorAll<HTMLElement>('.unity-afp-line'));
      for (const row of rows) {
        row.dataset.current = String(Number(row.dataset.index) === lineIndex);
      }
      if (audioFollowModeEnabled && lineIndex >= 0) {
        const current = audioFollowLinesHost.querySelector<HTMLElement>('.unity-afp-line[data-current="true"]');
        current?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      }
      updateAudioFollowMeta();
    };

    const syncAudioFollowPanel = () => {
      if (!audioFollowModeEnabled || audioLines.length === 0 || audioSelectionLineRects.length === 0) {
        removeAudioFollowPanel();
        clearPageHighlights();
        return;
      }
      removeAudioFollowPanel();
      renderPageHighlights();
      updateCurrentPageLineFromCharIndex(audioCurrentCharIndex);
    };

    const prepareAudioText = (text: string, range?: Range) => {
      audioCurrentText = text.replace(/\s+/g, ' ').trim();
      const split = splitTranscriptLines(audioCurrentText);
      audioLines = split.lines;
      audioLineOffsets = split.offsets;
      audioCurrentCharIndex = 0;
      audioCurrentLineIndex = audioLines.length > 0 ? 0 : -1;
      audioSelectionRange = range ?? null;
      audioSelectionLineRects = range ? buildSelectionLineRects(range) : [];
      recomputeSelectionLineWeights();
      syncAudioFollowPanel();
    };

    const stopAudioPlayback = (resetPosition: boolean) => {
      const synth = getSpeechEngine();
      synth?.cancel();
      audioUtterance = null;
      audioIsSpeaking = false;
      audioIsPaused = false;
      audioNeedsRestartOnResume = false;
      if (resetPosition) {
        audioCurrentCharIndex = 0;
        audioCurrentLineIndex = audioLines.length > 0 ? 0 : -1;
      }
      syncAudioFollowPanel();
      clearPageHighlights();
    };

    const speakFromOffset = async (offset: number): Promise<void> => {
      const synth = getSpeechEngine();
      if (!synth) throw new Error('This browser does not support speech synthesis.');
      if (!audioCurrentText.trim()) throw new Error('No text available to read.');

      let safeOffset = clamp(offset, 0, Math.max(0, audioCurrentText.length - 1));
      let remaining = audioCurrentText.slice(safeOffset);
      const leadingWhitespace = remaining.match(/^\s*/)?.[0].length ?? 0;
      safeOffset += leadingWhitespace;
      remaining = audioCurrentText.slice(safeOffset);
      if (!remaining.trim()) {
        stopAudioPlayback(false);
        return;
      }

      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(remaining);
      utterance.rate = clampAudioRate(audioRate);

      utterance.onstart = () => {
        audioIsSpeaking = true;
        audioIsPaused = false;
        audioNeedsRestartOnResume = false;
        audioCurrentCharIndex = safeOffset;
        updateAudioLineHighlight(resolveLineIndexFromChar(safeOffset));
        updateCurrentPageLineFromCharIndex(safeOffset);
      };

      utterance.onboundary = (event) => {
        const localIndex = Number.isFinite(event.charIndex) ? event.charIndex : 0;
        audioCurrentCharIndex = safeOffset + Math.max(0, localIndex);
        updateAudioLineHighlight(resolveLineIndexFromChar(audioCurrentCharIndex));
        updateCurrentPageLineFromCharIndex(audioCurrentCharIndex);
      };

      utterance.onpause = () => {
        audioIsPaused = true;
      };

      utterance.onresume = () => {
        audioIsPaused = false;
      };

      utterance.onend = () => {
        if (audioUtterance !== utterance) return;
        audioUtterance = null;
        audioIsSpeaking = false;
        audioIsPaused = false;
        audioCurrentCharIndex = audioCurrentText.length;
        updateAudioLineHighlight(audioLines.length > 0 ? audioLines.length - 1 : -1);
        setCurrentPageLineHighlight(-1);
        clearPageHighlights();
      };

      utterance.onerror = () => {
        if (audioUtterance !== utterance) return;
        audioUtterance = null;
        audioIsSpeaking = false;
        audioIsPaused = false;
      };

      audioUtterance = utterance;
      synth.speak(utterance);
    };

    const readSelectionAndSpeak = async () => {
      const snapshot = getCurrentSelectionSnapshot();
      if (!snapshot?.text) {
        throw new Error('Select text on the page first.');
      }
      prepareAudioText(snapshot.text, snapshot.range);
      await speakFromOffset(0);
    };

    const startFromLatestSelectionIfChanged = async (): Promise<boolean> => {
      const snapshot = getCurrentSelectionSnapshot();
      if (!snapshot?.text) return false;
      if (snapshot.text === audioCurrentText) return false;
      prepareAudioText(snapshot.text, snapshot.range);
      await speakFromOffset(0);
      return true;
    };

    const setAudioRateAndApply = async (nextRate: number) => {
      audioRate = clampAudioRate(nextRate);
      if (audioIsSpeaking && !audioIsPaused) {
        await speakFromOffset(audioCurrentCharIndex);
      } else if (audioIsPaused) {
        audioNeedsRestartOnResume = true;
      }
    };

    const setAudioFollowMode = (enabled: boolean) => {
      audioFollowModeEnabled = enabled;
      if (enabled && audioSelectionRange) {
        audioSelectionLineRects = buildSelectionLineRects(audioSelectionRange);
        recomputeSelectionLineWeights();
      } else if (!enabled) {
        audioSelectionLineWeightEnds = [];
        audioSelectionLineWeightTotal = 0;
      }
      syncAudioFollowPanel();
    };

    const playAudio = async () => {
      const synth = getSpeechEngine();
      if (!synth) {
        throw new Error('This browser does not support speech synthesis.');
      }
      if (await startFromLatestSelectionIfChanged()) {
        return;
      }
      if (audioIsPaused) {
        if (audioNeedsRestartOnResume) {
          await speakFromOffset(audioCurrentCharIndex);
        } else {
          synth.resume();
          audioIsPaused = false;
        }
        return;
      }
      if (audioIsSpeaking) return;
      if (audioCurrentText.trim()) {
        const restartOffset = audioCurrentCharIndex >= audioCurrentText.length ? 0 : audioCurrentCharIndex;
        await speakFromOffset(restartOffset);
        return;
      }
      await readSelectionAndSpeak();
    };

    const pauseAudio = () => {
      const synth = getSpeechEngine();
      if (!synth) return;
      if (synth.speaking && !synth.paused) {
        synth.pause();
        audioIsPaused = true;
      }
    };

    const getAudioState = (): AudioContentState => {
      const selectedText = getCurrentSelectionText();
      return {
        available: Boolean(getSpeechEngine()),
        hasSelection: selectedText.length > 0,
        selectionText: selectedText,
        isSpeaking: audioIsSpeaking,
        isPaused: audioIsPaused,
        rate: clampAudioRate(audioRate),
        followMode: audioFollowModeEnabled,
        currentLineIndex: audioCurrentLineIndex,
        totalLines: audioLines.length,
        currentLineText:
          audioCurrentLineIndex >= 0 && audioCurrentLineIndex < audioLines.length
            ? audioLines[audioCurrentLineIndex]
            : '',
      };
    };

    const audioResponse = (ok: boolean, error?: string) => {
      const state = getAudioState();
      return ok ? { ok: true, state } : { ok: false, error: error ?? 'Audio command failed.', state };
    };

    const removeActionBar = () => {
      actionBar?.remove();
      actionBar = null;
    };

    const removeCard = () => {
      card?.remove();
      card = null;
    };

    const hideAllUi = () => {
      removeActionBar();
      removeCard();
      activeSelection = null;
      requestToken += 1;
      lastPointerAnchor = null;
    };

    const showCard = (
      state: CardState,
      action: SelectionAction,
      text: string,
      selection: SelectionSnapshot,
      level: RewriteLevel,
    ) => {
      if (!card) {
        card = createCard(() => {
          hideAllUi();
        }, colorBlindModeEnabled);
        document.documentElement.appendChild(card);
      }
      applyColorBlindModeToUi();
      card.dataset.state = state;
      const title = card.querySelector<HTMLElement>('.cred-selection-title');
      const body = card.querySelector<HTMLElement>('.cred-selection-body');
      if (title) {
        title.textContent = `${ACTION_CONFIG[action].title} - Level ${level}`;
      }
      if (body) {
        body.textContent = text;
      }
      positionNearSelection(card, selection);
    };

    const handleActionClick = async (action: SelectionAction) => {
      if (!activeSelection) return;
      const token = ++requestToken;
      const selected = activeSelection;
      const level = selectedLevel;
      removeActionBar();
      showCard('loading', action, ACTION_CONFIG[action].loadingText, selected, level);

      const response = await sendActionRequest(action, selected.text, level);
      if (token !== requestToken) return;

      if (!response.ok) {
        showCard('error', action, response.error ?? ACTION_CONFIG[action].emptyErrorText, selected, level);
        return;
      }

      showCard('done', action, response.result ?? selected.text, selected, level);
    };

    const showSelectionActions = (snapshot: SelectionSnapshot) => {
      if (!actionBar) {
        actionBar = createActionBar(
          selectedLevel,
          (action) => {
            void handleActionClick(action);
          },
          (level) => {
            selectedLevel = level;
          },
          colorBlindModeEnabled,
        );
        document.documentElement.appendChild(actionBar);
      }
      applyColorBlindModeToUi();
      setActionBarLevel(actionBar, selectedLevel);
      activeSelection = snapshot;
      positionNearSelection(actionBar, snapshot);
    };

    const refreshSelectionUi = () => {
      const snapshot = getSelectionSnapshot(lastPointerAnchor);
      if (!snapshot) {
        removeActionBar();
        activeSelection = null;
        return;
      }
      removeCard();
      showSelectionActions(snapshot);
    };

    document.addEventListener(
      'selectionchange',
      () => {
        if (pointerSelectionInProgress) return;
        refreshSelectionUi();
      },
      true,
    );

    document.addEventListener(
      'mousedown',
      (event) => {
        if (isUiNode(event.target as Node | null)) return;
        pointerSelectionInProgress = true;
        lastPointerAnchor = null;
        removeCard();
      },
      true,
    );

    document.addEventListener(
      'mouseup',
      (event) => {
        if (isUiNode(event.target as Node | null)) return;
        pointerSelectionInProgress = false;
        lastPointerAnchor = {
          x: event.clientX,
          y: event.clientY,
          at: Date.now(),
        };
        window.setTimeout(refreshSelectionUi, 0);
      },
      true,
    );

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') {
          hideAllUi();
        }
      },
      true,
    );

    const onRuntimeMessage = (
      rawMessage: unknown,
      _sender: unknown,
      sendResponse: (response?: unknown) => void,
    ) => {
      const message = rawMessage as ContentRequest | undefined;
      if (!message || typeof message !== 'object' || typeof (message as { type?: unknown }).type !== 'string') {
        return;
      }
      if (
        message.type !== 'FORM_SCAN_FIELDS' &&
        message.type !== 'FORM_FILL_FIELDS' &&
        message.type !== 'FORM_UNDO_FILL' &&
        message.type !== 'FORM_GET_UNDO_STATUS' &&
        !(message.type as string).startsWith('AUDIO_')
      ) {
        return;
      }

      void (async () => {
        try {
          switch (message.type) {
            case 'FORM_SCAN_FIELDS':
              sendResponse({
                ok: true,
                fields: detectFillableFormFields(),
              });
              return;
            case 'FORM_FILL_FIELDS': {
              const fillSummary = fillDetectedFormFields(Array.isArray(message.selections) ? message.selections : []);
              sendResponse({
                ok: true,
                summary: fillSummary,
                undoAvailable: getUndoAvailability(),
              });
              return;
            }
            case 'FORM_UNDO_FILL':
              sendResponse({
                ok: true,
                summary: undoLastFillAction(),
                undoAvailable: getUndoAvailability(),
              });
              return;
            case 'FORM_GET_UNDO_STATUS':
              sendResponse({
                ok: true,
                undoAvailable: getUndoAvailability(),
              });
              return;
            case 'AUDIO_GET_STATE':
            case 'AUDIO_GET_SELECTION':
              sendResponse(audioResponse(true));
              return;
            case 'AUDIO_READ_SELECTION':
              if (typeof message.rate === 'number') {
                audioRate = clampAudioRate(message.rate);
              }
              if (typeof message.followMode === 'boolean') {
                setAudioFollowMode(message.followMode);
              }
              await readSelectionAndSpeak();
              sendResponse(audioResponse(true));
              return;
            case 'AUDIO_PLAY':
              await playAudio();
              sendResponse(audioResponse(true));
              return;
            case 'AUDIO_PAUSE':
              pauseAudio();
              sendResponse(audioResponse(true));
              return;
            case 'AUDIO_STOP':
              stopAudioPlayback(true);
              sendResponse(audioResponse(true));
              return;
            case 'AUDIO_SET_RATE':
              await setAudioRateAndApply(message.rate);
              sendResponse(audioResponse(true));
              return;
            case 'AUDIO_SET_FOLLOW_MODE':
              setAudioFollowMode(Boolean(message.enabled));
              sendResponse(audioResponse(true));
              return;
            default:
              sendResponse(audioResponse(false, 'Unknown audio message.'));
          }
        } catch (error) {
          if (
            message.type === 'FORM_SCAN_FIELDS' ||
            message.type === 'FORM_FILL_FIELDS' ||
            message.type === 'FORM_UNDO_FILL' ||
            message.type === 'FORM_GET_UNDO_STATUS'
          ) {
            sendResponse({
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : message.type === 'FORM_FILL_FIELDS'
                    ? 'Field fill failed.'
                    : message.type === 'FORM_UNDO_FILL'
                      ? 'Undo failed.'
                      : message.type === 'FORM_GET_UNDO_STATUS'
                        ? 'Failed to fetch undo status.'
                        : 'Field scan failed.',
            });
            return;
          }
          sendResponse(audioResponse(false, error instanceof Error ? error.message : 'Audio command failed.'));
        }
      })();

      return true;
    };

    const onStorageChanged = (
      changes: Record<string, { newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;
      if (REDUCE_MOTION_STORAGE_KEY in changes) {
        applyReducedMotion(Boolean(changes[REDUCE_MOTION_STORAGE_KEY]?.newValue));
      }
      if (COLOR_BLIND_MODE_STORAGE_KEY in changes) {
        colorBlindModeEnabled = Boolean(changes[COLOR_BLIND_MODE_STORAGE_KEY]?.newValue);
        applyColorBlindModeToUi();
        applyPageColorBlindMode(colorBlindModeEnabled);
      }
      if (FORCED_FONT_STORAGE_KEY in changes) {
        forcedFont = normalizeForcedFont(changes[FORCED_FONT_STORAGE_KEY]?.newValue);
        applyForcedPageFont(forcedFont);
        syncForcedFontRescanLoop();
      }
      if (AUDIO_RATE_STORAGE_KEY in changes) {
        const nextRate = clampAudioRate(Number(changes[AUDIO_RATE_STORAGE_KEY]?.newValue ?? audioRate));
        void setAudioRateAndApply(nextRate);
      }
      if (AUDIO_FOLLOW_MODE_STORAGE_KEY in changes) {
        setAudioFollowMode(Boolean(changes[AUDIO_FOLLOW_MODE_STORAGE_KEY]?.newValue));
      }
    };

    ext.runtime.onMessage.addListener(onRuntimeMessage as any);
    ext.storage.onChanged.addListener(onStorageChanged);
    ensureForcedFontObserver();
    void ext.storage.local
      .get([
        REDUCE_MOTION_STORAGE_KEY,
        COLOR_BLIND_MODE_STORAGE_KEY,
        FORCED_FONT_STORAGE_KEY,
        AUDIO_RATE_STORAGE_KEY,
        AUDIO_FOLLOW_MODE_STORAGE_KEY,
      ])
      .then((stored) => {
        reduceMotionEnabled = Boolean(stored?.[REDUCE_MOTION_STORAGE_KEY]);
        colorBlindModeEnabled = Boolean(stored?.[COLOR_BLIND_MODE_STORAGE_KEY]);
        forcedFont = normalizeForcedFont(stored?.[FORCED_FONT_STORAGE_KEY]);
        audioRate = clampAudioRate(Number(stored?.[AUDIO_RATE_STORAGE_KEY] ?? 1));
        audioFollowModeEnabled = Boolean(stored?.[AUDIO_FOLLOW_MODE_STORAGE_KEY]);
        applyReducedMotion(reduceMotionEnabled);
        applyColorBlindModeToUi();
        applyPageColorBlindMode(colorBlindModeEnabled);
        applyForcedPageFont(forcedFont);
        syncForcedFontRescanLoop();
        syncAudioFollowPanel();
      })
      .catch(() => {
        // Ignore storage read errors.
      });

    window.addEventListener(
      'scroll',
      () => {
        hideAllUi();
      },
      true,
    );

    const onResize = () => {
      hideAllUi();
      if (audioFollowModeEnabled && audioSelectionRange) {
        audioSelectionLineRects = buildSelectionLineRects(audioSelectionRange);
        recomputeSelectionLineWeights();
        renderPageHighlights();
        updateCurrentPageLineFromCharIndex(audioCurrentCharIndex);
      }
    };

    window.addEventListener('resize', onResize);
    window.addEventListener('beforeunload', () => {
      stopAudioPlayback(false);
      removeAudioFollowPanel();
      clearPageHighlights();
      forcedFontObserver?.disconnect();
      forcedFontObserver = null;
      stopForcedFontRescanLoop();
      stopGifFreezeObserver();
      stopReduceMotionRescanLoop();
      window.removeEventListener('resize', onResize);
      ext.runtime.onMessage.removeListener(onRuntimeMessage as any);
      ext.storage.onChanged.removeListener(onStorageChanged);
    });
  },
});
