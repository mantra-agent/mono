import { createLogger } from "./log";
import { getSetting, setSetting } from "./system-settings";
import { getSecretSync } from "./secrets-store";

const log = createLogger("Pronunciation");

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

export interface PronunciationEntry {
  word: string;
  alias: string;
  createdAt: string;
}

interface PronunciationDictState {
  dictionaryId: string;
  versionId: string;
}

const SETTING_KEY_STATE = "voice_pronunciation";
const SETTING_KEY_ENTRIES = "voice_pronunciation_entries";

async function getApiKey(): Promise<string> {
  const key = getSecretSync("ELEVENLABS_API_KEY");
  if (!key) throw new Error("ElevenLabs API key not configured.");
  return key;
}

async function getDictState(): Promise<PronunciationDictState | null> {
  return getSetting<PronunciationDictState>(SETTING_KEY_STATE);
}

async function setDictState(state: PronunciationDictState): Promise<void> {
  await setSetting(SETTING_KEY_STATE, state);
}

export async function getEntries(): Promise<PronunciationEntry[]> {
  const entries = await getSetting<PronunciationEntry[]>(SETTING_KEY_ENTRIES);
  return entries || [];
}

async function saveEntries(entries: PronunciationEntry[]): Promise<void> {
  await setSetting(SETTING_KEY_ENTRIES, entries);
}

async function createDictionary(entries: PronunciationEntry[]): Promise<PronunciationDictState> {
  const apiKey = await getApiKey();
  const rules = entries.map(e => ({
    type: "alias" as const,
    string_to_replace: e.word,
    alias: e.alias,
  }));

  log.log(`Creating pronunciation dictionary with ${rules.length} rules`);

  const res = await fetch(`${ELEVENLABS_API_BASE}/pronunciation-dictionaries/add-from-rules`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "xyz Pronunciation",
      description: "User-managed pronunciation corrections for xyz voice",
      rules,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    log.error(`Failed to create pronunciation dictionary: ${res.status} ${error}`);
    throw new Error(`Failed to create pronunciation dictionary: ${res.status} ${error}`);
  }

  const data = await res.json();
  const state: PronunciationDictState = {
    dictionaryId: data.id,
    versionId: data.version_id,
  };
  log.log(`Created dictionary id=${state.dictionaryId} version=${state.versionId}`);
  return state;
}

async function addRulesToDictionary(dictionaryId: string, entries: PronunciationEntry[]): Promise<string> {
  const apiKey = await getApiKey();
  const rules = entries.map(e => ({
    type: "alias" as const,
    string_to_replace: e.word,
    alias: e.alias,
  }));

  log.log(`Adding ${rules.length} rules to dictionary ${dictionaryId}`);

  const res = await fetch(`${ELEVENLABS_API_BASE}/pronunciation-dictionaries/${dictionaryId}/add-rules`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ rules }),
  });

  if (!res.ok) {
    const error = await res.text();
    log.error(`Failed to add rules: ${res.status} ${error}`);
    throw new Error(`Failed to add pronunciation rules: ${res.status} ${error}`);
  }

  const data = await res.json();
  return data.version_id;
}

async function removeRulesFromDictionary(dictionaryId: string, words: string[]): Promise<string> {
  const apiKey = await getApiKey();
  const rule_strings = words;

  log.log(`Removing ${rule_strings.length} rules from dictionary ${dictionaryId}`);

  const res = await fetch(`${ELEVENLABS_API_BASE}/pronunciation-dictionaries/${dictionaryId}/remove-rules`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ rule_strings }),
  });

  if (!res.ok) {
    const error = await res.text();
    log.error(`Failed to remove rules: ${res.status} ${error}`);
    throw new Error(`Failed to remove pronunciation rules: ${res.status} ${error}`);
  }

  const data = await res.json();
  return data.version_id;
}

async function patchAgentPronunciation(state: PronunciationDictState | null): Promise<void> {
  const agentId = getSecretSync("ELEVENLABS_AGENT_ID");
  if (!agentId) {
    log.warn("Cannot attach pronunciation to agent: ELEVENLABS_AGENT_ID not set");
    return;
  }

  const apiKey = await getApiKey();
  const locators = state
    ? [{ pronunciation_dictionary_id: state.dictionaryId, version_id: state.versionId }]
    : [];

  log.log(`Patching agent ${agentId} with ${locators.length} pronunciation dictionary locator(s)`);

  const res = await fetch(`${ELEVENLABS_API_BASE}/convai/agents/${agentId}`, {
    method: "PATCH",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      conversation_config: {
        tts: {
          pronunciation_dictionary_locators: locators,
        },
      },
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    log.error(`Failed to patch agent pronunciation: ${res.status} ${error}`);
    throw new Error(`Failed to attach pronunciation dictionary to agent: ${res.status} ${error}`);
  }

  log.log(`Agent pronunciation patched successfully`);
}

export async function listEntries(): Promise<PronunciationEntry[]> {
  return getEntries();
}

export async function addEntry(word: string, alias: string): Promise<PronunciationEntry> {
  if (!word || !alias) throw new Error("Both word and alias (pronunciation) are required");

  const entries = await getEntries();
  const existing = entries.find(e => e.word === word);
  if (existing) {
    throw new Error(`Entry for "${word}" already exists. Use update to change it.`);
  }

  const newEntry: PronunciationEntry = {
    word,
    alias,
    createdAt: new Date().toISOString(),
  };

  const state = await getDictState();
  let newState: PronunciationDictState;

  if (state) {
    const versionId = await addRulesToDictionary(state.dictionaryId, [newEntry]);
    newState = { ...state, versionId };
  } else {
    const allEntries = [...entries, newEntry];
    newState = await createDictionary(allEntries);
  }

  entries.push(newEntry);
  await Promise.all([
    saveEntries(entries),
    setDictState(newState),
  ]);

  await patchAgentPronunciation(newState);

  log.log(`Added pronunciation: "${word}" → "${alias}"`);
  return newEntry;
}

export async function updateEntry(word: string, newAlias: string): Promise<PronunciationEntry> {
  if (!word || !newAlias) throw new Error("Both word and new alias are required");

  const entries = await getEntries();
  const idx = entries.findIndex(e => e.word === word);
  if (idx === -1) {
    throw new Error(`No pronunciation entry found for "${word}"`);
  }

  const state = await getDictState();
  let updatedState = state;
  if (state) {
    await removeRulesFromDictionary(state.dictionaryId, [word]);
    const versionId = await addRulesToDictionary(state.dictionaryId, [{ word, alias: newAlias, createdAt: entries[idx].createdAt }]);
    updatedState = { ...state, versionId };
    await setDictState(updatedState);
  }

  entries[idx].alias = newAlias;
  await saveEntries(entries);

  if (updatedState) {
    await patchAgentPronunciation(updatedState);
  }

  log.log(`Updated pronunciation: "${word}" → "${newAlias}"`);
  return entries[idx];
}

export async function removeEntry(word: string): Promise<boolean> {
  if (!word) throw new Error("Word is required");

  const entries = await getEntries();
  const idx = entries.findIndex(e => e.word === word);
  if (idx === -1) {
    throw new Error(`No pronunciation entry found for "${word}"`);
  }

  const state = await getDictState();
  let updatedState = state;
  if (state) {
    const versionId = await removeRulesFromDictionary(state.dictionaryId, [word]);
    updatedState = { ...state, versionId };
    await setDictState(updatedState);
  }

  entries.splice(idx, 1);
  await saveEntries(entries);

  if (updatedState) {
    await patchAgentPronunciation(updatedState);
  }

  log.log(`Removed pronunciation for "${word}"`);
  return true;
}

export async function getDictionaryLocator(): Promise<{ pronunciation_dictionary_id: string; version_id: string } | null> {
  const state = await getDictState();
  if (!state) return null;
  return {
    pronunciation_dictionary_id: state.dictionaryId,
    version_id: state.versionId,
  };
}
