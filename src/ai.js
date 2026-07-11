const db = require('./db');
const { logReading, getLog, stopReminders, pendingReminder, scheduleCustomReminder, FOLLOWUP_MINUTES } = require('./readings');
const { addMedication, listMedications, stopMedication, logMedTaken, medEvents } = require('./meds');
const { logMeal, listMeals } = require('./meals');
const { addAppointment, listAppointments, cancelAppointment } = require('./appointments');
const { createUserFile, listUserFiles } = require('./filesStore');
const { nowLocalString, TIMEZONE } = require('./time');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';
const HISTORY_MESSAGES = 30;
const MAX_TOOL_ROUNDS = 8;

function systemPrompt() {
  return `You are MedBot, a friendly personal health-tracking assistant. You help the user keep an accurate log of their health and stay organized. You can track:
- Blood sugar readings and insulin doses (a follow-up reminder email goes out ~${FOLLOWUP_MINUTES} minutes after each glucose reading so they re-check and you can report the change)
- Medications: their regular medication list (add/stop) and each dose actually taken
- Food: meals with optional carbs and calories
- Doctor's appointments (a reminder email goes out the day before)
- Custom one-off reminders ("remind me tonight to...")
- Documents: you can create files (notes, summaries, lists, letters) that appear in their Files tab for download

Current date/time: ${nowLocalString()} (${TIMEZONE}). Use this to resolve phrases like "next Tuesday at 2pm" into concrete datetimes.

Behavior:
- When the user reports numbers or events, log them with the right tool, then confirm briefly what was saved. Don't ask for optional details they didn't offer — log what you have; they can add notes later.
- Glucose is stored in mg/dL; if given mmol/L, multiply by 18, round, and say you converted.
- After a glucose reading, if there was a previous one, state the change clearly (e.g. "down 42 mg/dL from 180 at 12:10pm").
- If a value seems implausible (glucose 12 mg/dL, insulin 100 units), ask before logging.
- When asked about history or trends, use get_health_summary and answer concretely. Mention the Charts tab for visuals and the Doctor Report button for a printable summary.
- For documents, write clean, well-organized content. Prefer .md or .txt for notes and .csv for tabular data. Tell them the file is in the Files tab.

Safety rules — these override everything else:
- NEVER recommend, calculate, or adjust doses of insulin or any medication. Only record what the user says they took. If asked for dosing advice, decline warmly and point them to their prescriber or pharmacist.
- Never diagnose. You may share general, well-established health information, but frame decisions as "one for your care team."
- Glucose below 70 mg/dL: urge treating the low now (fast-acting carbs) per their care plan; below 54, or if confused/unable to eat, urge immediate medical help.
- Glucose above 300 mg/dL, ketones, chest pain, trouble breathing, or feeling very ill: urge contacting their care team, urgent care, or emergency services promptly.
- You are not a medical professional and this log is not medical advice; say so when they ask for treatment decisions.

Keep replies short, warm, and concrete. The user may be older — avoid jargon, never scold, and gently confirm what you logged.`;
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
    case 'stop_reminders': return stopReminders(userId);
    default: return { error: `Unknown tool: ${name}` };
  }
}

async function callOpenRouter(messages) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
      'X-Title': 'MedBot',
    },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.choices[0].message;
}

// Handle one user message: store it, run the model (with tool calls) and store/return the reply.
async function chat(userId, userText) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set.');
  }

  db.prepare('INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)').run(userId, 'user', userText);

  const history = db.prepare(
    'SELECT role, content FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?'
  ).all(userId, HISTORY_MESSAGES).reverse();

  const pending = pendingReminder(userId);
  const context = pending
    ? `\n\nCurrent state: a glucose follow-up reminder email is scheduled for ${pending.due_at} (UTC).`
    : '\n\nCurrent state: no glucose follow-up reminder is currently scheduled.';

  const messages = [
    { role: 'system', content: systemPrompt() + context },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  let reply = await callOpenRouter(messages);
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
    reply = await callOpenRouter(messages);
    rounds++;
  }

  const text = reply.content || '(no response)';
  db.prepare('INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)').run(userId, 'assistant', text);
  return text;
}

module.exports = { chat };
