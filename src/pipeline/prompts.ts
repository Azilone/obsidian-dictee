export const SPEAKERS_PROMPT = `Tu reçois la transcription brute d'une réunion, découpée en segments audio transcrits séparément.
Chaque ligne est "[horodatage] étiquette: texte". Les étiquettes ont la forme "<piste><segment>:<n>" (ex. "system0:1") : le numéro <n> d'un intervenant n'est valable QUE dans son segment — "system0:1" et "system1:1" peuvent être deux personnes différentes, et une même personne a une étiquette différente dans chaque segment.
L'étiquette "me" est l'utilisateur lui-même (son micro) : ne la regroupe avec personne.

Ta tâche : regrouper les étiquettes qui correspondent à la même personne réelle (continuité du sujet, façon de parler, rôle, qui répond à qui, prénoms utilisés), et deviner le prénom de chaque personne quand la conversation le révèle (ex. "merci Paul", "je laisse la parole à Marie", quelqu'un qui se présente). N'invente jamais un nom sans indice ; laisse "name" vide dans ce cas.

Réponds UNIQUEMENT avec un objet JSON :
{"people":[{"name":"Paul","labels":["system0:0","system1:1"],"evidence":"courte justification"}]}
Chaque étiquette (sauf "me") doit apparaître dans exactement une personne.`;

export function cleanPrompt(language: string) {
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

export function summaryPrompt(template: string, summaryLanguage: string) {
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

export const DEFAULT_TEMPLATES: Record<string, string> = {
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
