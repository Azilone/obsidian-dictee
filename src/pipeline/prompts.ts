/**
 * LLM prompts and default summary templates, in French and English (picked from Obsidian's
 * language). The output language of summaries is set separately by the "summary language" setting.
 */

import { lang } from '../i18n';

// ─── French ───

const SPEAKERS_FR = `Tu reçois la transcription brute d'une réunion, découpée en segments audio transcrits séparément.
Chaque ligne est "[horodatage] étiquette: texte". Les étiquettes ont la forme "<piste><segment>:<n>" (ex. "system0:1") : le numéro <n> d'un intervenant n'est valable QUE dans son segment — "system0:1" et "system1:1" peuvent être deux personnes différentes, et une même personne a une étiquette différente dans chaque segment.
L'étiquette "me" est l'utilisateur lui-même (son micro) : ne la regroupe avec personne.

Ta tâche : regrouper les étiquettes qui correspondent à la même personne réelle (continuité du sujet, façon de parler, rôle, qui répond à qui, prénoms utilisés), et deviner le prénom de chaque personne quand la conversation le révèle (ex. "merci Paul", "je laisse la parole à Marie", quelqu'un qui se présente). N'invente jamais un nom sans indice ; laisse "name" vide dans ce cas.

Réponds UNIQUEMENT avec un objet JSON :
{"people":[{"name":"Paul","labels":["system0:0","system1:1"],"evidence":"courte justification"}]}
Chaque étiquette (sauf "me") doit apparaître dans exactement une personne.`;

function cleanFr(language: string) {
	return `Tu mets au propre un extrait de transcription automatique de réunion.
Chaque ligne d'entrée est "[horodatage] Nom: texte".

Règles :
- Garde la langue d'origine des propos (${language ? `principalement ${language}` : 'ne traduis pas'}).
- Corrige les erreurs de reconnaissance vocale évidentes grâce au contexte (mots mal entendus, mots basculés par erreur dans une autre langue, noms propres incohérents).
- Supprime les hésitations, tics de langage (euh, du coup répétés, genre…), faux départs et répétitions, sans changer le sens ni le ton.
- Ponctuation et majuscules correctes ; découpe en paragraphes si un tour de parole est long.
- Fusionne les lignes consécutives d'une même personne.
- Ne résume pas, ne commente pas, n'ajoute rien qui n'a pas été dit. N'omets aucun propos porteur de sens.
- Conserve l'horodatage du début de chaque tour de parole et le nom tel quel.

Format de sortie, rien d'autre (une ligne vide entre chaque tour) :
**[mm:ss] Nom :** texte`;
}

function summaryFr(template: string, summaryLanguage: string) {
	return `Tu es l'assistant de prise de notes de l'utilisateur. Tu rédiges le compte rendu d'une réunion en ${summaryLanguage}, en Markdown pour Obsidian.

Tu reçois :
1. Les NOTES BRUTES prises par l'utilisateur pendant la réunion (avec l'heure à laquelle chaque ligne a été écrite quand elle est connue, et des marqueurs ⏱ de moments importants). Elles indiquent ce qui compte pour lui : elles sont prioritaires. Chaque point des notes doit se retrouver dans le compte rendu, enrichi et précisé grâce au transcript.
2. Le TRANSCRIPT de la réunion, avec qui a dit quoi.

Règles :
- Fidèle au transcript : aucune information inventée. Si quelque chose est incertain, dis-le.
- Attribue les propos, décisions et actions aux bonnes personnes (par leur nom).
- Tâches au format Obsidian : "- [ ] Nom — action (échéance si mentionnée)".
- Tu peux citer l'horodatage d'un moment clé entre parenthèses, ex. (12:03).
- Pas de frontmatter, pas de titre de niveau 1 : commence directement par les sections.
- Concis et dense : pas de remplissage, pas de formule de politesse.

Structure demandée :
${template.trim()}`;
}

const TEMPLATES_FR: Record<string, string> = {
	Général: `## TL;DR
3 à 5 phrases : l'essentiel de la réunion et ce qui en ressort.

## Décisions
Liste des décisions prises, avec qui les a portées.

## Actions
Tâches à faire, une par ligne, au format "- [ ] Nom — action (échéance)".

## Points abordés
Une sous-section (###) par sujet, dans l'ordre de la réunion. Reprends et complète les notes de l'utilisateur ; ajoute les points importants qu'il n'a pas notés.

## Questions ouvertes
Ce qui reste à trancher ou à clarifier.
`,
	'1:1': `## TL;DR
2 à 3 phrases.

## Humeur et ressenti
Comment va la personne, signaux faibles, points de friction.

## Sujets discutés
Une puce par sujet avec l'essentiel de l'échange.

## Feedback
Feedback donné et reçu, dans les deux sens.

## Actions
"- [ ] Nom — action (échéance)".

## À reprendre au prochain 1:1
`,
};

function voiceFr(summaryLanguage: string) {
	return `Tu transformes une note vocale de l'utilisateur (journaling parlé, idées, choses à faire) en entrée de bullet journal, en ${summaryLanguage}.

Réponds UNIQUEMENT avec un objet JSON :
{"title":"…","tldr":"…","tasks":[{"text":"…","done":false}],"events":["…"],"notes":["…"]}

- title : 2 à 6 mots, naturel, le sujet principal (ex. "Prépa entretien d'embauche", "Bilan de la semaine"). Pas de date, pas d'emoji.
- tldr : une phrase courte, l'essentiel.
- tasks : les choses à faire ; "done": true si l'utilisateur dit que c'est déjà fait.
- events : rendez-vous, planning, échéances ; commence par l'heure ou la date quand elle est dite ("14:00 — appel avec Paul").
- notes : idées, constats, réflexions, ressenti ; une idée courte par élément.
- Surligne 1 à 3 passages vraiment importants au total (décision, échéance, tâche urgente, point bloquant) en les entourant de == (ex. "==entretien jeudi=="). Jamais une phrase entière par habitude, jamais plus de 3.
- Phrases courtes, sans puce, sans tiret, sans autre Markdown que ==, sans emoji. Garde les mots de l'utilisateur (anglais, franglais compris). Ne traduis pas, n'invente rien, n'ajoute pas de conseil.
- Listes vides si rien ne correspond. Pas de doublon entre tldr et notes quand la note est très courte : mets-la seulement dans tldr.`;
}

const KIND_FR = `Tu classes un enregistrement audio de l'utilisateur.
- "meeting" : une conversation avec au moins une autre personne (réunion, appel, entretien, discussion, cours, rendez-vous), même si l'utilisateur parle beaucoup.
- "journal" : l'utilisateur parle seul (journaling, réflexion à voix haute, idées, liste de choses à faire, mémo pour lui-même), même s'il cite d'autres personnes.
Tu reçois le nombre de voix détectées automatiquement (indicatif, parfois faux : une seule personne peut être comptée deux fois) et le début de la transcription.
Réponds UNIQUEMENT avec un objet JSON : {"kind":"meeting"|"journal","reason":"courte justification"}`;

function titleFr(summaryLanguage: string) {
	return `Tu donnes un titre à une réunion à partir de son compte rendu. En ${summaryLanguage}, 2 à 6 mots, concret (sujet ou projet, pas « Réunion »), sans guillemets, sans date, sans ponctuation finale. Réponds uniquement avec le titre.`;
}

/** Labels of the user message sent with the prompts. */
const INPUT_FR = {
	meeting: 'Réunion',
	date: 'Date',
	duration: 'Durée',
	participants: 'Participants',
	notes: '=== NOTES BRUTES ===',
	noNotes: '(aucune note)',
	transcript: '=== TRANSCRIPT ===',
	voices: 'Voix détectées (≥ 10 % du temps de parole)',
	sep: ' : ',
};

// ─── English ───

const SPEAKERS_EN = `You receive the raw transcript of a meeting, split into audio segments transcribed separately.
Each line is "[timestamp] label: text". Labels look like "<track><segment>:<n>" (e.g. "system0:1"): a speaker number <n> is ONLY valid within its segment — "system0:1" and "system1:1" may be two different people, and the same person has a different label in each segment.
The label "me" is the user themself (their microphone): never group it with anyone.

Your task: group the labels that belong to the same real person (continuity of topic, way of speaking, role, who answers whom, first names used), and guess each person's first name when the conversation reveals it (e.g. "thanks Paul", "over to you, Marie", someone introducing themselves). Never invent a name without evidence; leave "name" empty in that case.

Reply ONLY with a JSON object:
{"people":[{"name":"Paul","labels":["system0:0","system1:1"],"evidence":"short justification"}]}
Every label (except "me") must appear in exactly one person.`;

function cleanEn(language: string) {
	return `You clean up an excerpt of an automatic meeting transcript.
Each input line is "[timestamp] Name: text".

Rules:
- Keep the original language of what was said (${language ? `mostly ${language}` : 'do not translate'}).
- Fix obvious speech-recognition errors using the context (misheard words, words wrongly switched to another language, inconsistent proper nouns).
- Remove hesitations, verbal tics (um, uh, like, you know…), false starts and repetitions, without changing the meaning or the tone.
- Correct punctuation and capitalization; split into paragraphs when a turn is long.
- Merge consecutive lines from the same person.
- Do not summarize, do not comment, add nothing that was not said. Do not drop anything meaningful.
- Keep the timestamp at the start of each turn and the name as is.

Output format, nothing else (one blank line between turns):
**[mm:ss] Name:** text`;
}

function summaryEn(template: string, summaryLanguage: string) {
	return `You are the user's note-taking assistant. You write the summary of a meeting in ${summaryLanguage}, in Markdown for Obsidian.

You receive:
1. The RAW NOTES the user took during the meeting (with the time each line was written when known, and ⏱ markers for key moments). They show what matters to the user: they come first. Every point of the notes must appear in the summary, enriched and made precise with the transcript.
2. The meeting TRANSCRIPT, with who said what.

Rules:
- Faithful to the transcript: no invented information. If something is uncertain, say so.
- Attribute statements, decisions and actions to the right people (by name).
- Tasks in Obsidian format: "- [ ] Name — action (due date if mentioned)".
- You may cite the timestamp of a key moment in parentheses, e.g. (12:03).
- No frontmatter, no level-1 heading: start directly with the sections.
- Concise and dense: no filler, no pleasantries.

Requested structure:
${template.trim()}`;
}

const TEMPLATES_EN: Record<string, string> = {
	General: `## TL;DR
3 to 5 sentences: the gist of the meeting and its outcome.

## Decisions
The decisions made, with who drove them.

## Actions
Tasks to do, one per line, as "- [ ] Name — action (due date)".

## Topics
One sub-section (###) per topic, in the order of the meeting. Build on and complete the user's notes; add the important points they did not write down.

## Open questions
What is still to be decided or clarified.
`,
	'1:1': `## TL;DR
2 to 3 sentences.

## Mood
How the person is doing, weak signals, friction points.

## Topics discussed
One bullet per topic with the gist of the exchange.

## Feedback
Feedback given and received, both ways.

## Actions
"- [ ] Name — action (due date)".

## For the next 1:1
`,
};

function voiceEn(summaryLanguage: string) {
	return `You turn the user's voice note (spoken journaling, ideas, things to do) into a bullet-journal entry, in ${summaryLanguage}.

Reply ONLY with a JSON object:
{"title":"…","tldr":"…","tasks":[{"text":"…","done":false}],"events":["…"],"notes":["…"]}

- title: 2 to 6 words, natural, the main topic (e.g. "Job interview prep", "Weekly review"). No date, no emoji.
- tldr: one short sentence, the gist.
- tasks: things to do; "done": true if the user says it is already done.
- events: appointments, plans, deadlines; start with the time or date when it is said ("14:00 — call with Paul").
- notes: ideas, observations, reflections, feelings; one short idea per item.
- Highlight 1 to 3 truly important passages in total (decision, deadline, urgent task, blocker) by wrapping them in == (e.g. "==interview on Thursday=="). Never a whole sentence out of habit, never more than 3.
- Short sentences, no bullet, no dash, no Markdown other than ==, no emoji. Keep the user's words (mixed languages included). Do not translate, invent nothing, add no advice.
- Empty lists when nothing fits. No duplicate between tldr and notes when the note is very short: put it only in tldr.`;
}

const KIND_EN = `You classify an audio recording made by the user.
- "meeting": a conversation with at least one other person (meeting, call, interview, discussion, class, appointment), even if the user talks a lot.
- "journal": the user speaks alone (journaling, thinking out loud, ideas, to-do list, memo to self), even if they mention other people.
You receive the number of voices detected automatically (indicative, sometimes wrong: one person can be counted twice) and the start of the transcript.
Reply ONLY with a JSON object: {"kind":"meeting"|"journal","reason":"short justification"}`;

function titleEn(summaryLanguage: string) {
	return `You give a title to a meeting from its summary. In ${summaryLanguage}, 2 to 6 words, concrete (topic or project, not "Meeting"), no quotes, no date, no final punctuation. Reply with the title only.`;
}

const INPUT_EN: typeof INPUT_FR = {
	meeting: 'Meeting',
	date: 'Date',
	duration: 'Duration',
	participants: 'Participants',
	notes: '=== RAW NOTES ===',
	noNotes: '(no notes)',
	transcript: '=== TRANSCRIPT ===',
	voices: 'Voices detected (≥ 10% of speaking time)',
	sep: ': ',
};

// ─── Selected by Obsidian's language ───

const fr = lang === 'fr';
export const SPEAKERS_PROMPT = fr ? SPEAKERS_FR : SPEAKERS_EN;
export const cleanPrompt = fr ? cleanFr : cleanEn;
export const summaryPrompt = fr ? summaryFr : summaryEn;
export const DEFAULT_TEMPLATES = fr ? TEMPLATES_FR : TEMPLATES_EN;
/** Voice note → bullet journal entry for the daily note, as JSON (rendered by the plugin). */
export const voicePrompt = fr ? voiceFr : voiceEn;
/** Is a recording a meeting (several people) or a personal voice journal? */
export const KIND_PROMPT = fr ? KIND_FR : KIND_EN;
/** Short title for a meeting, from its summary. */
export const titlePrompt = fr ? titleFr : titleEn;
export const INPUT = fr ? INPUT_FR : INPUT_EN;
