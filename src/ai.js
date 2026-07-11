const db = require('./db');
const { logReading, getLog, stopReminders, pendingReminder, scheduleCustomReminder, FOLLOWUP_MINUTES } = require('./readings');
const { addMedication, listMedications, stopMedication, logMedTaken, medEvents } = require('./meds');
const { logMeal, listMeals } = require('./meals');
const { addAppointment, listAppointments, cancelAppointment } = require('./appointments');
const { addRecurring, listRecurring, cancelRecurring } = require('./recurring');
const { createUserFile, listUserFiles } = require('./filesStore');
const { resolveApiConfig } = require('./settings');
const { saveMemory, forgetMemory, searchMemories, memoryContext, summarizeEpisodeIfNeeded } = require('./memory');
const { nowLocalString, TIMEZONE } = require('./time');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const HISTORY_MESSAGES = 30;
const MAX_TOOL_ROUNDS = 12;
const ROUTER_HISTORY_MESSAGES = 6;

function systemPrompt() {
  return `You are Amy, a friendly personal health assistant. You help the user keep an accurate log of their health, remember things for them, and stay organized — like a patient, capable companion who never gets tired of helping.

How the user talks to you: usually by VOICE on a phone. Their messages arrive through speech-to-text, so expect mis-heard words ("metformin" may arrive as "met forming") — infer what they meant and confirm when it matters. Your replies are read ALOUD by text-to-speech, so write the way you'd speak: short, warm, plain sentences. No markdown, no asterisks, no headers, no tables, no long bullet lists — they'd be narrated as clutter. Say numbers and times the way a person would say them.

Everything you can do (when asked "what can you do", explain these in plain, friendly language):
- Blood sugar & insulin: log readings and doses (a follow-up reminder email goes out ~${FOLLOWUP_MINUTES} minutes after each glucose reading so they re-check), and tell them how much it changed since last time
- Medications: keep their medication list (add/stop) and record each dose actually taken. They can also tap the "📷 Scan medicine bottle" button in Chat to photograph a label — you receive what it says and file it into their list.
- Food: log meals, with carbs and calories when known
- Doctor's appointments: track them (a reminder email goes out the day before), list and cancel them
- One-off reminders ("remind me tonight to...") sent by email
- Recurring reminders ("remind me every morning at 8 to take my metformin"): daily, weekly on chosen days, or every N minutes/hours. When one fires, YOU reach out — the reminder pops up in chat and is spoken out loud, with a backup email. To change one, cancel it and create the new version. They can also see and delete them in the Reminders tab.
- Research & questions: answer general health and everyday questions from your knowledge, plainly and honestly — and say so when you're not sure or something is better asked of their care team
- Documents: create files (notes, question lists for the doctor, summaries, letters) that appear in their Files tab
- History & trends: summarize their data concretely; the Charts tab has visuals, the Doctor Report button makes a printable summary they can email or print for appointments, and every table exports to CSV
- Memory: you remember lasting facts about them and can recall past conversations

Where things live in the app (tabs across the top): Chat (talking with you), Reminders, Log (all the tables plus the Doctor Report and email buttons), Charts, Appointments, Files, Memory (what you remember about them — they can correct it there).

Current date/time: ${nowLocalString()} (${TIMEZONE}). Use this to resolve phrases like "next Tuesday at 2pm" into concrete datetimes.

Memory: your short-term memory is the recent message window. Lasting facts about the user (allergies, conditions, doctor names, family, preferences, goals) should be saved with save_memory the moment you learn them — they are injected into future conversations. Use search_memory to recall older facts or past conversation summaries, and forget_memory when the user corrects or retracts something.

Behavior:
- When the user reports numbers or events, log them with the right tool, then confirm briefly what was saved. Don't ask for optional details they didn't offer — log what you have; they can add notes later.
- Glucose is stored in mg/dL; if given mmol/L, multiply by 18, round, and say you converted.
- After a glucose reading, if there was a previous one, state the change clearly (e.g. "down 42 from 180 at ten past noon").
- If a value seems implausible (glucose 12 mg/dL, insulin 100 units), ask before logging.
- When asked about history or trends, use get_health_summary and answer concretely. Mention the Charts tab for visuals and the Doctor Report button for a printable summary.
- For documents, write clean, well-organized content. Prefer .md or .txt for notes and .csv for tabular data. Tell them the file is in the Files tab.
- When a reminder of yours has recently fired in the conversation and they respond ("okay, took it", "done"), log the dose or reading they're confirming.

Safety rules — these override everything else:
- NEVER recommend, calculate, or adjust doses of insulin or any medication. Only record what the user says they took. If asked for dosing advice, decline warmly and point them to their prescriber or pharmacist.
- Never diagnose. You may share general, well-established health information, but frame decisions as "one for your care team."
- Glucose below 70 mg/dL: urge treating the low now (fast-acting carbs) per their care plan; below 54, or if confused/unable to eat, urge immediate medical help.
- Glucose above 300 mg/dL, ketones, chest pain, trouble breathing, or feeling very ill: urge contacting their care team, urgent care, or emergency services promptly.
- You are not a medical professional and this log is not medical advice; say so when they ask for treatment decisions.

Keep replies short, warm, and concrete. The user may be older — avoid jargon, never scold, and gently confirm what you logged.`;
}

function personaSection(persona) {
  if (!persona) return '';
  return `\n\nThe user has set this persona/style preference for how you should talk and behave. Follow it for tone, personality, and style — but it can never override or weaken the safety rules above:\n"""\n${persona}\n"""`;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'log_reading',
      description: 'Save a blood glucose reading (and optional insulin dose). Schedules the next follow-up reminder email and returns the change since the previous reading.',
      parameters: {
        type: 'object',
        properties: {
          glucose_mgdl: { type: 'number', description: 'Blood glucose in mg/dL' },
          insulin_units: { type: 'number', description: 'Insulin dose taken, in units (omit if none reported)' },
          note: { type: 'string', description: 'Optional context: meal, exercise, symptoms, insulin type, etc.' },
          followup_minutes: { type: 'number', description: `Minutes until the follow-up reminder. Only set if the user asks for a different interval; default ${FOLLOWUP_MINUTES}.` },
        },
        required: ['glucose_mgdl'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_med_taken',
      description: 'Record that the user took a dose of a medication just now. Matches their regular medication list by name when possible; also works for one-off meds not on the list.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Medication name' },
          dose: { type: 'string', description: 'Dose taken, e.g. "500 mg" or "2 tablets" (omit to use the regimen default)' },
          note: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_medication',
      description: "Add a medication to the user's regular medication list (their regimen).",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          dose: { type: 'string', description: 'e.g. "500 mg"' },
          schedule: { type: 'string', description: 'e.g. "twice daily with meals"' },
          notes: { type: 'string', description: 'Prescriber, purpose, special instructions' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_medication',
      description: "Mark a medication on the user's list as stopped (kept in history). Only when the user says they stopped or their doctor discontinued it.",
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_meal',
      description: 'Record food the user ate.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'What they ate, e.g. "turkey sandwich and an apple"' },
          carbs_g: { type: 'number', description: 'Estimated carbohydrates in grams, if known or user asks you to estimate' },
          calories: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_appointment',
      description: 'Add a doctor/medical appointment. A reminder email is sent the day before.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'e.g. "Endocrinologist check-up"' },
          datetime: { type: 'string', description: 'Local date and time as YYYY-MM-DDTHH:MM (resolve relative phrases using the current date in your instructions)' },
          provider: { type: 'string', description: 'Doctor or clinic name' },
          location: { type: 'string' },
          notes: { type: 'string', description: 'What to bring, questions to ask, etc.' },
        },
        required: ['title', 'datetime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_appointments',
      description: "List the user's appointments (upcoming by default).",
      parameters: {
        type: 'object',
        properties: { include_past: { type: 'boolean' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_appointment',
      description: 'Cancel an appointment by its id (from list_appointments). Confirm with the user first if there is any ambiguity about which one.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_health_summary',
      description: 'Get recent data across all categories: glucose readings (with changes), medication list, doses taken, meals, and upcoming appointments. Use to answer questions about history and trends.',
      parameters: {
        type: 'object',
        properties: { days: { type: 'number', description: 'How many days back to include (default 14)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_document',
      description: "Create a file in the user's Files tab (downloadable). Allowed extensions: .txt, .md, .csv, .html, .json. Use for notes, summaries, question lists for the doctor, exported data, letters, etc.",
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'e.g. "questions-for-dr-smith.md"' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: "List the files in the user's Files tab.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_reminder',
      description: 'Schedule a one-off reminder email, e.g. "remind me at 8pm to take my evening meds".',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What the reminder email should say' },
          minutes_from_now: { type: 'number', description: 'Minutes from now to send it' },
        },
        required: ['message', 'minutes_from_now'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_recurring_reminder',
      description: 'Create a recurring reminder. When it fires, the reminder pops up in chat, is spoken aloud, and a backup email is sent. Use for medicines, blood sugar checks, drinking water, exercise, etc.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What to remind, addressed to the user, e.g. "Take your metformin (500 mg)"' },
          frequency: { type: 'string', enum: ['daily', 'weekly', 'interval'] },
          time: { type: 'string', description: '24-hour local time "HH:MM" — required for daily and weekly' },
          weekdays: { type: 'array', items: { type: 'string' }, description: 'For weekly: day names, e.g. ["monday","thursday"]' },
          every_minutes: { type: 'number', description: 'For interval: fire every N minutes (e.g. every 4 hours = 240). Minimum 5.' },
        },
        required: ['message', 'frequency'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_recurring_reminders',
      description: "List the user's active recurring reminders with their ids, schedules, and next fire times.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_recurring_reminder',
      description: 'Cancel a recurring reminder by its id (from list_recurring_reminders). Confirm with the user first if it is ambiguous which one they mean.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save a lasting fact about the user to long-term memory (allergies, conditions, doctors, family, preferences, goals). One concise fact per call. Do not save routine log entries — those are already in the health log.',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string', description: 'The fact, e.g. "Allergic to penicillin" or "Primary care doctor is Dr. Alvarez at Mercy Clinic"' } },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget_memory',
      description: 'Delete a long-term memory by its id (ids are shown in your memory list) when the user corrects or retracts it. Save the corrected fact separately if needed.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: 'Search long-term memories and episodic summaries of older conversations. Use when the user references something from a while back that is not in the recent messages or your injected memories.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'A keyword or phrase to search for' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_reminders',
      description: 'Cancel pending glucose follow-up and custom reminder emails (appointment reminders are kept unless the appointment is canceled).',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function healthSummary(userId, days = 14) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  return {
    days,
    glucose_readings: getLog(userId, 500).filter((r) => r.taken_at >= since),
    medication_list: listMedications(userId, true),
    doses_taken: medEvents(userId, 500).filter((e) => e.taken_at >= since),
    meals: listMeals(userId, 500).filter((m) => m.eaten_at >= since),
    upcoming_appointments: listAppointments(userId, false),
  };
}

function runTool(userId, name, args) {
  switch (name) {
    case 'log_reading': return logReading(userId, args);
    case 'log_med_taken': return logMedTaken(userId, args);
    case 'add_medication': return { added: addMedication(userId, args) };
    case 'stop_medication': return stopMedication(userId, args.name);
    case 'log_meal': return { logged: logMeal(userId, args) };
    case 'add_appointment': return addAppointment(userId, args);
    case 'list_appointments': return { appointments: listAppointments(userId, Boolean(args.include_past)) };
    case 'cancel_appointment': return cancelAppointment(userId, args.id);
    case 'get_health_summary': return healthSummary(userId, args.days || 14);
    case 'create_document': return createUserFile(userId, args.filename, args.content);
    case 'list_files': return { files: listUserFiles(userId) };
    case 'schedule_reminder': return scheduleCustomReminder(userId, args.message, args.minutes_from_now);
    case 'add_recurring_reminder': return addRecurring(userId, args);
    case 'list_recurring_reminders': return { reminders: listRecurring(userId) };
    case 'cancel_recurring_reminder': return cancelRecurring(userId, args.id);
    case 'save_memory': return saveMemory(userId, args.content);
    case 'forget_memory': return forgetMemory(userId, args.id);
    case 'search_memory': return { results: searchMemories(userId, args.query) };
    case 'stop_reminders': return stopReminders(userId);
    default: return { error: `Unknown tool: ${name}` };
  }
}

async function callOpenRouter(messages, key, model, withTools = true) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
      'X-Title': 'MedBot',
    },
    body: JSON.stringify({ model, messages, ...(withTools ? { tools: TOOLS } : {}) }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.choices[0].message;
}

// ---- Pass 1: fast routing pre-pass ----
// A cheap model classifies the message first — what it's about, which tools
// the main model will likely need and in what order, values it can pre-extract
// — so the main model starts with a plan instead of figuring everything out
// mid-reply. Fails open: any error just means no hints.

function routerPrompt() {
  const toolList = TOOLS.map((t) => `- ${t.function.name}: ${t.function.description.split('.')[0]}`).join('\n');
  return `You are the fast routing pre-pass for Amy, a voice-first health assistant. You NEVER reply to the user and NEVER call tools — you only classify their newest message so the main model can act on it efficiently.

The main model has these tools:
${toolList}

Messages arrive via speech-to-text, so interpret likely mis-hearings ("met forming" = metformin, "blood sugar one eighty two" = 182).

Reply with STRICT JSON only (no markdown, no commentary):
{
  "topic": "short label, e.g. glucose_log | meds | meals | appointment | reminders | question | document | smalltalk | mixed",
  "user_wants": "one plain sentence saying what the user wants",
  "planned_actions": [ { "tool": "tool_name", "why": "brief reason", "args_hint": { } } ],
  "extracted": { "numbers, medication names, times, dates found in the message" },
  "multi_step": true/false,
  "safety_flag": null or "low_glucose" or "very_low_glucose" or "high_glucose" or "urgent_symptoms",
  "needs_clarification": null or "the one thing worth asking before acting"
}

List planned_actions in execution order; use an empty array when it's just conversation. If several things are asked at once, include an action per item. Never refuse anything — you only classify.`;
}

async function routeMessage(history, key, routerModel) {
  const recent = history.slice(-ROUTER_HISTORY_MESSAGES);
  const messages = [
    { role: 'system', content: routerPrompt() },
    ...recent.map((m, i) => ({
      role: m.role,
      content: (i === recent.length - 1 ? 'NEWEST MESSAGE (classify this): ' : '') + m.content,
    })),
  ];
  try {
    const reply = await callOpenRouter(messages, key, routerModel, false);
    const route = parseJsonLoose(reply.content);
    return route && typeof route === 'object' ? route : null;
  } catch (err) {
    console.warn('Router pre-pass failed (continuing without hints):', err.message.slice(0, 200));
    return null;
  }
}

// ---- Pass 2: the main model acts and replies ----
// Handle one user message: store it, run the model (with tool calls) and store/return the reply.
async function chat(userId, userText) {
  const { key, model, routerModel, persona } = resolveApiConfig();
  if (!key) {
    throw new Error('No OpenRouter API key configured yet — the administrator needs to add one in the Admin tab.');
  }

  db.prepare('INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)').run(userId, 'user', userText);

  const history = db.prepare(
    'SELECT role, content FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?'
  ).all(userId, HISTORY_MESSAGES).reverse();

  // Pass 1: cheap classifier plans the work.
  const route = await routeMessage(history, key, routerModel);

  const pending = pendingReminder(userId);
  const context = pending
    ? `\n\nCurrent state: a glucose follow-up reminder email is scheduled for ${pending.due_at} (UTC).`
    : '\n\nCurrent state: no glucose follow-up reminder is currently scheduled.';

  const messages = [
    { role: 'system', content: systemPrompt() + personaSection(persona) + memoryContext(userId) + context },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];
  if (route) {
    messages.push({
      role: 'system',
      content: `Routing pre-pass for the newest message (hints from a fast classifier — verify against the actual message; it may be wrong or incomplete):\n${JSON.stringify(route)}\nWork through every planned action that checks out, back to back, before replying. If a safety_flag is set, apply the safety rules first.`,
    });
  }

  let reply = await callOpenRouter(messages, key, model);
  let rounds = 0;
  while (reply.tool_calls && reply.tool_calls.length > 0 && rounds < MAX_TOOL_ROUNDS) {
    messages.push(reply);
    for (const call of reply.tool_calls) {
      let result;
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        result = runTool(userId, call.function.name, args);
      } catch (err) {
        result = { error: err.message };
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
    reply = await callOpenRouter(messages, key, model);
    rounds++;
  }

  const text = reply.content || '(no response)';
  const saved = db.prepare('INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)').run(userId, 'assistant', text);

  // Roll older messages into episodic memory in the background.
  const complete = async (msgs) => (await callOpenRouter(msgs, key, model, false)).content || '';
  summarizeEpisodeIfNeeded(userId, complete).catch((e) => console.error('Episode summarization failed:', e.message));

  return { reply: text, reply_id: Number(saved.lastInsertRowid) };
}

// A model that can read images, used when the configured model can't.
const VISION_FALLBACK_MODEL = 'anthropic/claude-haiku-4.5';

const VISION_PROMPT = `You read medication labels (prescription bottles, pill boxes, OTC packaging) from photos. Extract ONLY what is actually visible — never guess or fill in typical values. Reply with strict JSON, no markdown, using null for anything unreadable or absent:
{"is_medication_label": true/false, "name": "...", "strength": "...", "directions": "...", "prescriber": "...", "pharmacy": "...", "rx_number": "...", "quantity": "...", "refills": "...", "other_text": "..."}
If the photo is not a medication label, set is_medication_label to false and describe what you see in other_text.`;

function parseJsonLoose(raw) {
  const text = String(raw || '').replace(/```(?:json)?/g, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

// Read a medication label photo with a vision model, then run the result
// through the normal chat flow so the assistant updates the medication list
// and confirms out loud what it saved.
async function scanMedicationPhoto(userId, imageDataUrl) {
  const { key, model } = resolveApiConfig();
  if (!key) {
    throw new Error('No OpenRouter API key configured yet — the administrator needs to add one in the Admin tab.');
  }

  const visionMessages = [
    { role: 'system', content: VISION_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Read this medication label and return the JSON.' },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];

  let raw;
  try {
    raw = (await callOpenRouter(visionMessages, key, model, false)).content;
  } catch (err) {
    console.warn(`Vision read with ${model} failed (${err.message.slice(0, 120)}); retrying with ${VISION_FALLBACK_MODEL}`);
    raw = (await callOpenRouter(visionMessages, key, VISION_FALLBACK_MODEL, false)).content;
  }

  const label = parseJsonLoose(raw);
  const userText = label && label.is_medication_label !== false
    ? `📷 I scanned a medicine bottle. The label reads: ${JSON.stringify(label)}. If this medication isn't on my list yet, add it with the dose and schedule from the label and tell me clearly what you saved. If it's already on my list, just say so. If any important part was unreadable, mention it.`
    : `📷 I took a photo to scan a medicine bottle, but it doesn't look like a readable medication label${label?.other_text ? ` (the photo shows: ${label.other_text})` : ''}. Let me know to try again with the label facing the camera in good light.`;

  return chat(userId, userText);
}

// Clear the conversation. If the LLM is configured, first roll the whole
// unsummarized stretch into an episodic memory so nothing important is lost.
async function clearChat(userId) {
  let summarized = false;
  const { key, model } = resolveApiConfig();
  if (key) {
    try {
      const complete = async (msgs) => (await callOpenRouter(msgs, key, model, false)).content || '';
      summarized = Boolean(await summarizeEpisodeIfNeeded(userId, complete, true));
    } catch (err) {
      console.error('Pre-clear summarization failed (clearing anyway):', err.message);
    }
  }
  const info = db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
  return { cleared: info.changes, summarized };
}

module.exports = { chat, clearChat, scanMedicationPhoto };
