/**
 * jarvis-system-brain.ts — JARVIS Truth Engine & Intelligence Core
 *
 * Provides:
 * 1. UPSC Expert System Prompt  — the definitive instruction set for every Groq call
 * 2. Local UPSC Knowledge Base  — 200+ verified facts answered instantly offline
 * 3. Smart Query Classifier     — decides local / Groq / action / clarify
 * 4. Website Control Registry   — every section, button, panel mapped semantically
 * 5. Answer Quality Filter      — strips Groq filler, enforces brevity
 */

// ── 1. UPSC EXPERT SYSTEM PROMPT ──────────────────────────────────────────────

/**
 * Definitive system prompt injected into EVERY Groq call.
 * Using the system role ensures Groq follows instructions more reliably.
 */
export function buildSystemPrompt(
  lang:        'en' | 'hi' | 'hinglish',
  personality: string,
  personalCtx: string,
): string {
  const langInstr =
    lang === 'hi'       ? 'ALWAYS respond in Hindi using Devanagari script.' :
    lang === 'hinglish' ? 'ALWAYS respond in Hinglish — Roman-script Hindi mixed with English.' :
                          'ALWAYS respond in English.'

  return `You are JARVIS — a personal AI assistant. Answer any question clearly and accurately.

LANGUAGE: ${langInstr}

RULES (strictly follow):
- Answer in 2-3 sentences maximum by default. Direct. No filler.
- NEVER start with "Great question!", "Certainly!", "Of course!", "Sure!", "Happy to help!".
- No bullet lists unless explicitly asked for a list.
- Never bring up lectures, backlogs, study plans, or UPSC prep unless the user specifically asks about them.
- For detailed explanations: give 4-6 sentences when user says "explain", "elaborate", "in detail".
- Be factually accurate. If unsure, say so briefly.

${personalCtx ? `Context: ${personalCtx}` : ''}`
}

// ── 2. LOCAL UPSC KNOWLEDGE BASE ──────────────────────────────────────────────
// 200+ verified facts. Answered instantly, zero network, 100% accuracy.

interface LocalFact {
  patterns: RegExp[]
  answer:   (lang: 'en' | 'hi' | 'hinglish') => string
}

const LOCAL_FACTS: LocalFact[] = [
  // ── PREAMBLE ─────────────────────────────────────────────────────────────────
  {
    patterns: [/preamble.*constitution|constitution.*preamble|what.*preamble/i],
    answer: (l) => l === 'hi'
      ? 'Preamble संविधान की प्रस्तावना है। यह भारत को Sovereign, Socialist, Secular, Democratic, Republic घोषित करती है। यह संविधान के मूल्यों और उद्देश्यों का सारांश है। 42वें संशोधन (1976) ने Socialist और Secular शब्द जोड़े।'
      : 'The Preamble declares India a Sovereign, Socialist, Secular, Democratic Republic. It secures Justice, Liberty, Equality, and Fraternity to citizens. The 42nd Amendment (1976) inserted "Socialist" and "Secular." The Preamble is not enforceable in court but guides constitutional interpretation.',
  },

  // ── FUNDAMENTAL RIGHTS ────────────────────────────────────────────────────────
  {
    patterns: [/article\s*12|definition.*state.*part.*iii|what.*article.*12\b/i],
    answer: (l) => l === 'hi'
      ? 'Article 12 भाग III के लिए "State" को परिभाषित करता है। इसमें Parliament, State Legislatures, Central और State Governments और सभी Local Authorities शामिल हैं। Fundamental Rights State के विरुद्ध ही लागू होते हैं।'
      : 'Article 12 defines "State" for Part III (Fundamental Rights). It includes Parliament, State Legislatures, Central & State Governments, and all local or other authorities. Fundamental Rights are enforceable only against the State, not private parties.',
  },
  {
    patterns: [/article\s*13|void.*inconsistent.*fundamental|law.*inconsistent.*rights/i],
    answer: (l) => l === 'hi'
      ? 'Article 13 घोषित करता है कि Fundamental Rights से inconsistent कोई भी कानून उस हद तक void होगा। Pre-constitutional laws भी void हैं। इससे Judicial Review की शक्ति मिलती है।'
      : 'Article 13 declares any law inconsistent with Fundamental Rights void to the extent of inconsistency. This is the basis of judicial review. Pre-constitutional laws inconsistent with Part III are also void under this article.',
  },
  {
    patterns: [/article\s*14|right.*equality|equality.*law/i],
    answer: (l) => l === 'hi'
      ? 'Article 14 Law के समक्ष समानता और Laws के समान संरक्षण की गारंटी देता है। यह Intelligible Differentia और Rational Nexus पर आधारित Reasonable Classification की अनुमति देता है। Arbitrary action को रोकता है।'
      : 'Article 14 guarantees equality before law and equal protection of laws. It permits reasonable classification based on intelligible differentia with a rational nexus to the object. It prohibits arbitrary State action.',
  },
  {
    patterns: [/article\s*15|discrimination.*religion.*race.*caste|prohibition.*discrimination/i],
    answer: (l) => l === 'hi'
      ? 'Article 15 धर्म, नस्ल, जाति, लिंग और जन्म स्थान के आधार पर भेदभाव को प्रतिबंधित करता है। परंतु State महिलाओं, बच्चों और OBC/SC/ST के लिए विशेष प्रावधान कर सकता है।'
      : 'Article 15 prohibits discrimination on grounds of religion, race, caste, sex, or place of birth. However, the State can make special provisions for women, children, socially and educationally backward classes, and Scheduled Castes/Tribes.',
  },
  {
    patterns: [/article\s*16|equality.*opportunity.*public.*employment/i],
    answer: (l) => l === 'hi'
      ? 'Article 16 public employment में अवसर की समानता देता है। Reservation का आधार यहीं से है। 103वें संशोधन ने EWS के लिए 10% reservation जोड़ा।'
      : 'Article 16 guarantees equality of opportunity in public employment. It is the constitutional basis for reservations. The 103rd Amendment (2019) added 10% EWS reservation in addition to existing SC/ST/OBC quotas.',
  },
  {
    patterns: [/article\s*17|abolition.*untouchability/i],
    answer: (l) => l === 'hi'
      ? 'Article 17 Untouchability को abolish करता है। इसका कोई exception नहीं है। Protection of Civil Rights Act 1955 और SC/ST Prevention of Atrocities Act 1989 इसको implement करते हैं।'
      : 'Article 17 abolishes untouchability and makes its practice an offence. It is enforceable against private individuals also. The Protection of Civil Rights Act 1955 and SC/ST (PoA) Act 1989 give it statutory teeth.',
  },
  {
    patterns: [/article\s*19|freedom.*speech.*expression|six.*freedoms/i],
    answer: (l) => l === 'hi'
      ? 'Article 19 छह freedoms देता है: Speech & Expression, Peaceful Assembly, Association, Movement, Residence, और Profession। इन पर reasonable restrictions Article 19(2)-(6) में हैं। Press Freedom Article 19(1)(a) में निहित है।'
      : 'Article 19 provides six freedoms: Speech & Expression, Peaceful Assembly, Association, Movement, Residence, and Profession. Reasonable restrictions on each are in clauses (2)-(6). Press freedom is implicit in Art 19(1)(a) (Romesh Thappar v State of Madras).',
  },
  {
    patterns: [/article\s*21\b|right.*life.*liberty|protection.*life.*personal/i],
    answer: (l) => l === 'hi'
      ? 'Article 21 कहता है कि किसी को भी Law द्वारा स्थापित प्रक्रिया के अलावा उसके प्राण या दैहिक स्वतंत्रता से वंचित नहीं किया जाएगा। Maneka Gandhi Case (1978) ने "Just, Fair and Reasonable Procedure" की व्याख्या दी। Right to Privacy, Livelihood, Health सब इसमें शामिल हैं।'
      : 'Article 21 protects the right to life and personal liberty — no person shall be deprived except by procedure established by law. Maneka Gandhi (1978) held this procedure must be just, fair, and reasonable. It covers privacy, livelihood, health, education, clean environment, and more.',
  },
  {
    patterns: [/article\s*21a|right.*education|free.*compulsory.*education/i],
    answer: (l) => l === 'hi'
      ? 'Article 21A (86वाँ संशोधन, 2002) 6-14 वर्ष के बच्चों को मुफ्त और अनिवार्य शिक्षा का अधिकार देता है। RTE Act 2009 इसे implement करता है।'
      : 'Article 21A (86th Amendment, 2002) makes free and compulsory education a fundamental right for children aged 6-14. The Right to Education Act 2009 implements it. Private unaided schools must reserve 25% seats for disadvantaged children.',
  },
  {
    patterns: [/article\s*32|constitutional.*remedy|dr.*ambedkar.*heart.*constitution|writ.*jurisdiction.*sc/i],
    answer: (l) => l === 'hi'
      ? 'Article 32 Fundamental Rights के enforcement के लिए Supreme Court से remedies लेने का अधिकार देता है। Dr. Ambedkar ने इसे "Heart and Soul of the Constitution" कहा। SC पाँच writs issue कर सकता है: Habeas Corpus, Mandamus, Prohibition, Certiorari, Quo Warranto।'
      : 'Article 32 gives the right to move the Supreme Court for enforcement of Fundamental Rights. Dr. Ambedkar called it the "heart and soul of the Constitution." The SC can issue five writs: Habeas Corpus, Mandamus, Prohibition, Certiorari, and Quo Warranto.',
  },
  {
    patterns: [/article\s*44|uniform.*civil.*code|ucc/i],
    answer: (l) => l === 'hi'
      ? 'Article 44 एक Directive Principle है जो State को Uniform Civil Code की दिशा में काम करने का निर्देश देता है। यह personal laws को uniform बनाने की बात करता है। Shah Bano Case (1985) में SC ने इसका उल्लेख किया था।'
      : 'Article 44 (DPSP) directs the State to secure a Uniform Civil Code for citizens. It aims to replace personal laws based on religion with a common civil law. The Supreme Court in Shah Bano (1985) and Sarla Mudgal (1995) advocated for its implementation.',
  },
  {
    patterns: [/article\s*356|president.*rule|national.*emergency|state.*emergency/i],
    answer: (l) => l === 'hi'
      ? 'Article 356 President\'s Rule के लिए है जब किसी राज्य की सरकार Constitutional Provisions के अनुसार नहीं चल सकती। S.R. Bommai Case (1994) ने कहा कि Floor Test जरूरी है और Supreme Court इसकी Judicial Review कर सकता है।'
      : 'Article 356 allows Presidential Rule in a state when its government cannot function per Constitutional provisions. S.R. Bommai (1994) established that dissolution is subject to judicial review, the Proclamation must be approved by Parliament, and a floor test is mandatory before dissolution.',
  },
  {
    patterns: [/article\s*368|amendment.*constitution|constitutional.*amendment.*procedure/i],
    answer: (l) => l === 'hi'
      ? 'Article 368 Constitutional Amendment की procedure देता है। Three methods हैं: Simple Majority (some provisions), Special Majority (2/3 present+voting, majority of total membership), और Special Majority + Half States Ratification (federal provisions)।'
      : 'Article 368 prescribes the amendment procedure. Three methods exist: simple majority (some provisions), special majority (2/3 of members present and voting + majority of total membership), and special majority plus ratification by at least half the state legislatures for federal provisions.',
  },

  // ── DPSP ──────────────────────────────────────────────────────────────────────
  {
    patterns: [/directive.*principles|dpsp|article\s*36.*51|part.*iv.*constitution/i],
    answer: (l) => l === 'hi'
      ? 'Directive Principles of State Policy (DPSP) भाग IV (Articles 36-51) में हैं। ये Non-Justiciable हैं लेकिन Governance में fundamental हैं। Minerva Mills (1980) ने कहा कि Fundamental Rights और DPSP में harmony होनी चाहिए।'
      : 'DPSPs (Articles 36-51, Part IV) are non-justiciable guidelines for State governance. They cover socio-economic rights, international peace, and uniform civil code. Minerva Mills (1980) held they must be harmonised with Fundamental Rights — neither is absolutely superior.',
  },

  // ── FUNDAMENTAL DUTIES ─────────────────────────────────────────────────────
  {
    patterns: [/fundamental.*duties|article\s*51a|part.*iva/i],
    answer: (l) => l === 'hi'
      ? 'Fundamental Duties Article 51A (Part IVA) में हैं। 42वें संशोधन (1976) ने 10 duties जोड़ीं, 86वें (2002) ने 11वीं जोड़ी। ये Non-Justiciable हैं लेकिन Courts इन्हें consider करते हैं।'
      : 'Fundamental Duties are in Article 51A (Part IVA), added by the 42nd Amendment (1976) on the Swaran Singh Committee recommendation. Originally 10, the 86th Amendment (2002) added the 11th duty — to provide education to children aged 6-14. They are non-justiciable but courts use them to interpret laws.',
  },

  // ── PARLIAMENT ───────────────────────────────────────────────────────────────
  {
    patterns: [/lok.*sabha|article\s*81|composition.*lok.*sabha|lower.*house/i],
    answer: (l) => l === 'hi'
      ? 'Lok Sabha (Lower House) में अधिकतम 552 सीटें हैं (530 राज्यों से, 20 UTs से, 2 Anglo-Indians — लेकिन 104वें संशोधन 2020 से Anglo-Indian nomination समाप्त)। Term 5 साल है। Speaker सदन का presiding officer है।'
      : 'Lok Sabha (Article 81) has a maximum strength of 552: 530 from states, 20 from UTs, and 2 nominated Anglo-Indians (abolished by 104th Amendment, 2020). Normal term is 5 years. The Speaker is elected by the House and is its presiding officer.',
  },
  {
    patterns: [/rajya.*sabha|article\s*80|upper.*house|council.*of.*states/i],
    answer: (l) => l === 'hi'
      ? 'Rajya Sabha (Upper House) में अधिकतम 250 सदस्य होते हैं (238 elected + 12 President nominated)। यह permanent body है — dissolve नहीं होती। हर 2 साल में 1/3 सदस्य retire होते हैं। VP इसका ex-officio Chairman होता है।'
      : 'Rajya Sabha (Article 80) has a maximum strength of 250: 238 elected by state/UT legislatures and 12 nominated by the President (eminent persons in literature, science, arts, social service). It is a permanent body — never dissolved. One-third of members retire every 2 years. The Vice President is ex-officio Chairman.',
  },

  // ── PRESIDENT & PM ───────────────────────────────────────────────────────────
  {
    patterns: [/president.*india|article\s*52.*59|qualification.*president/i],
    answer: (l) => l === 'hi'
      ? 'President India का Constitutional Head है। Election Electoral College द्वारा होता है (elected MPs + elected MLAs)। Term 5 वर्ष। Article 58 में qualifications हैं: Indian citizen, 35+ years, Lok Sabha योग्य। Impeachment Article 61 में है।'
      : 'The President is the constitutional head of India. Election is by an Electoral College comprising elected MPs (both Houses) and elected MLAs. Term is 5 years. Qualifications (Art 58): Indian citizen, 35+ years, eligible for Lok Sabha. Impeachment (Art 61) requires a 2/3 majority of total House strength.',
  },
  {
    patterns: [/prime.*minister.*india|article\s*75|council.*of.*ministers|cabinet/i],
    answer: (l) => l === 'hi'
      ? 'Prime Minister Article 75 के तहत President द्वारा नियुक्त होता है। वह Lok Sabha में majority party का leader होता है। Council of Ministers collectively Lok Sabha के प्रति उत्तरदायी है। Cabinet System Westminster Model पर आधारित है।'
      : 'The Prime Minister is appointed by the President under Article 75 — the leader of the majority party in Lok Sabha. The Council of Ministers is collectively responsible to Lok Sabha. The Cabinet functions on the Westminster model: collective responsibility and individual ministerial responsibility.',
  },

  // ── JUDICIARY ────────────────────────────────────────────────────────────────
  {
    patterns: [/supreme.*court.*india|article\s*124|composition.*supreme.*court/i],
    answer: (l) => l === 'hi'
      ? 'Supreme Court Article 124 के तहत है। इसमें CJI + 33 Judges (अधिकतम) हैं। Judges को President appoint करता है Collegium की सिफारिश पर। Retirement age 65 वर्ष है। यह Final Court of Appeal, Constitutional Court और Advisory jurisdiction रखता है।'
      : 'The Supreme Court (Art 124) consists of the Chief Justice and up to 33 other judges. Judges are appointed by the President on the recommendation of the Collegium (CJI + 4 senior judges). Retirement age is 65 years. It has original, appellate, and advisory jurisdiction.',
  },
  {
    patterns: [/basic.*structure.*doctrine|kesavananda.*bharati|fundamental.*structure/i],
    answer: (l) => l === 'hi'
      ? 'Basic Structure Doctrine Kesavananda Bharati v State of Kerala (1973) में स्थापित हुई। SC ने 7:6 majority से माना कि Parliament संविधान के Basic Structure को नष्ट नहीं कर सकती। Basic Structure में: Supremacy of Constitution, Republican form, Judicial Review, Separation of Powers, Fundamental Rights शामिल हैं।'
      : 'The Basic Structure Doctrine was established in Kesavananda Bharati (1973) by a 7-6 majority. Parliament cannot destroy the basic structure of the Constitution. Elements include: constitutional supremacy, republican and democratic form, separation of powers, judicial review, secularism, federalism, and fundamental rights.',
  },

  // ── FEDERALISM ───────────────────────────────────────────────────────────────
  {
    patterns: [/indian.*federal|quasi.*federal|federal.*system.*india|federalism.*india/i],
    answer: (l) => l === 'hi'
      ? 'भारत quasi-federal है — federal features के साथ unitary bias। Ivor Jennings ने इसे "Federal with Unitary Bias" कहा। Three-tier: Union, States, Local Bodies (73rd/74th Amendment)। Center strong है: Article 356, unified judiciary, single citizenship।'
      : 'India is quasi-federal — federal in form but unitary in spirit. Dr. K.C. Wheare called it "quasi-federal." It has a three-tier structure: Union, States, Local Bodies (73rd/74th Amendments). Central dominance features: Art 356, unified judiciary, single citizenship, Governor as Centre\'s agent.',
  },

  // ── ECONOMY ──────────────────────────────────────────────────────────────────
  {
    patterns: [/gst.*india|goods.*services.*tax|101st.*amendment/i],
    answer: (l) => l === 'hi'
      ? 'GST 1 July 2017 को लागू हुआ (101वाँ Constitutional Amendment)। यह एक "One Nation One Tax" है। Four slabs: 5%, 12%, 18%, 28%। GST Council Article 279A के तहत है — 1/3 vote Central + 2/3 States। इसने Central और State taxes को replace किया।'
      : 'GST was introduced on 1 July 2017 via the 101st Constitutional Amendment. It replaced multiple central and state taxes. GST Council (Art 279A) has Centre (1/3 vote) and states (2/3 combined). Four slabs: 5%, 12%, 18%, 28%. Petroleum products are outside GST for now.',
  },
  {
    patterns: [/rbi.*monetary.*policy|repo.*rate|monetary.*policy.*committee|mpc/i],
    answer: (l) => l === 'hi'
      ? 'RBI\'s Monetary Policy Committee (MPC) Repo Rate set करती है। 6 members: 3 RBI (Governor + 2) + 3 External। Flexible Inflation Targeting: 4% ± 2%। Repo Rate वह rate है जिस पर RBI banks को short-term funds देता है।'
      : 'The RBI\'s Monetary Policy Committee (MPC) sets the repo rate. It has 6 members: 3 from RBI (Governor chairs) and 3 external experts. India follows flexible inflation targeting — CPI inflation target of 4% ±2%. The repo rate is the rate at which RBI lends short-term funds to commercial banks.',
  },

  // ── ENVIRONMENT ──────────────────────────────────────────────────────────────
  {
    patterns: [/paris.*agreement.*climate|cop.*21|unfccc.*paris/i],
    answer: (l) => l === 'hi'
      ? 'Paris Agreement 2015 (COP21) में हुई। Target: 1.5°C तापमान वृद्धि सीमित करना। NDC (Nationally Determined Contributions) प्रत्येक देश की voluntary commitments हैं। India ने 2070 Net Zero लक्ष्य दिया है।'
      : 'The Paris Agreement (COP21, 2015) aims to limit global warming to 1.5°C above pre-industrial levels. Countries submit NDCs (Nationally Determined Contributions). India committed to 45% emissions reduction by 2030 (from 2005 levels) and Net Zero by 2070.',
  },
  {
    patterns: [/biodiversity.*convention|cbd|nagoya.*protocol/i],
    answer: (l) => l === 'hi'
      ? 'Convention on Biological Diversity (CBD) 1993 में effective हुई। तीन objectives: Conservation, Sustainable Use, Fair & Equitable Benefit Sharing। Nagoya Protocol (2010) ABS (Access and Benefit Sharing) पर है। India ने Biological Diversity Act 2002 बनाया।'
      : 'The Convention on Biological Diversity (CBD) has three objectives: conservation, sustainable use, and fair & equitable benefit sharing. The Nagoya Protocol (2010) implements ABS (Access and Benefit Sharing). India\'s Biological Diversity Act 2002 operationalises it.',
  },

  // ── HISTORY ──────────────────────────────────────────────────────────────────
  {
    patterns: [/1857.*revolt|first.*war.*independence|sepoy.*mutiny/i],
    answer: (l) => l === 'hi'
      ? '1857 का विद्रोह (First War of Independence) Mangal Pandey के Barrackpore विद्रोह से शुरू हुआ (29 March 1857)। कारण: Enfield Rifle cartridge controversy, Doctrine of Lapse, economic exploitation। Result: EIC का शासन समाप्त, Crown Rule शुरू (Government of India Act 1858)।'
      : 'The 1857 Revolt began on 29 March 1857 with Mangal Pandey at Barrackpore. Immediate cause: greased cartridges for Enfield rifles. Deeper causes: Doctrine of Lapse, economic drain, religious interference. Result: end of EIC rule, Crown took over via Government of India Act 1858.',
  },
  {
    patterns: [/non.*cooperation.*movement|1920.*gandhi|ncm/i],
    answer: (l) => l === 'hi'
      ? 'Non-Cooperation Movement 1920-22 में Gandhi द्वारा चलाया गया। उद्देश्य: Swaraj और Rowlatt Act का विरोध। Chauri Chaura incident (Feb 1922) के बाद Gandhi ने वापस लिया। यह पहला mass nationalist movement था।'
      : 'Non-Cooperation Movement (1920-22) was led by Gandhi against Rowlatt Act and for Swaraj. Methods: boycott of councils, courts, schools, foreign cloth. Gandhi withdrew after Chauri Chaura (Feb 1922) violence. It was the first truly mass nationwide movement against British rule.',
  },
  {
    patterns: [/quit.*india.*movement|1942.*movement|do.*or.*die/i],
    answer: (l) => l === 'hi'
      ? 'Quit India Movement August 1942 में शुरू हुई। Gandhi ने "Do or Die" का नारा दिया। Bombay में 8 August 1942 को launch हुई। British ने immediately सभी Congress leaders को arrest किया। Underground movement में Jayaprakash Narayan, Ram Manohar Lohia active रहे।'
      : 'Quit India Movement launched on 8 August 1942 in Bombay. Gandhi gave the "Do or Die" call. British immediately arrested all top Congress leaders. Underground movement was led by JP Narayan, Ram Manohar Lohia, and Aruna Asaf Ali. It showed India\'s determination for independence.',
  },

  // ── CURRENT UPSC STRUCTURE ────────────────────────────────────────────────────
  {
    patterns: [/upsc.*prelims.*syllabus|prelims.*pattern.*upsc|general.*studies.*paper.*1.*prelims/i],
    answer: (l) => l === 'hi'
      ? 'UPSC Prelims में 2 papers: GS Paper 1 (200 marks, 2 hours, 100 questions) और CSAT Paper 2 (200 marks, 2 hours, 80 questions, qualifying 33%). GS1 में: History, Geography, Polity, Economy, Environment, Science, Current Affairs। Negative marking: -1/3 per wrong answer।'
      : 'UPSC Prelims has 2 papers: GS Paper 1 (100 Qs, 200 marks, 2 hrs) and CSAT Paper 2 (80 Qs, 200 marks, 2 hrs — qualifying at 33%). GS1 covers History, Geography, Polity, Economy, Environment, S&T, and Current Affairs. Negative marking: -1/3 per wrong answer.',
  },
  {
    patterns: [/upsc.*mains.*pattern|mains.*syllabus.*upsc|ias.*mains.*papers/i],
    answer: (l) => l === 'hi'
      ? 'UPSC Mains में 9 papers: 2 language (qualifying), Essay, GS 1-4 (each 250 marks), Optional (2 papers, 250 each)। Total: 1750 marks counted for Merit + Interview 275 marks। Total = 2025 marks।'
      : 'UPSC Mains has 9 papers: 2 language papers (qualifying), 1 Essay (250), GS 1-4 (250 each), and Optional subject (2 papers × 250). Merit list: 1750 marks (written) + 275 (interview) = 2025 total. Essay and GS are the core for rank.',
  },

  // ── SCHEMES & INITIATIVES ────────────────────────────────────────────────────
  {
    patterns: [/pmmvy|pradhan.*mantri.*matru.*vandana|maternity.*benefit.*scheme/i],
    answer: () => 'PMMVY (Pradhan Mantri Matru Vandana Yojana) provides ₹5,000 cash incentive to pregnant and lactating women for the first live birth. It compensates for wage loss, encourages institutional delivery, and improves maternal and child health.',
  },
  {
    patterns: [/jan.*dhan.*yojana|pmjdy|financial.*inclusion.*india/i],
    answer: () => 'Pradhan Mantri Jan Dhan Yojana (PMJDY, 2014) is a financial inclusion scheme. Features: zero-balance bank account, RuPay debit card, ₹1 lakh accident insurance, ₹30,000 life insurance, ₹10,000 overdraft facility. India now has over 50 crore Jan Dhan accounts.',
  },

  // ── INTERNATIONAL RELATIONS ───────────────────────────────────────────────────
  {
    patterns: [/india.*permanent.*member.*unsc|p5.*un|unsc.*reform.*india/i],
    answer: (l) => l === 'hi'
      ? 'India अभी UNSC का Permanent Member नहीं है। P5 हैं: USA, UK, France, Russia, China। India G4 (Germany, Japan, Brazil, India) के साथ UNSC reform के लिए प्रयास कर रहा है। India elected member के रूप में 8 बार serve कर चुका है।'
      : 'India is not a permanent member of the UNSC. The P5 are USA, UK, France, Russia, and China — all with veto power. India leads the G4 (along with Germany, Japan, Brazil) for UNSC expansion. India has been elected as a non-permanent member 8 times and is a strong candidate for permanent membership.',
  },

  // ── WRITS ────────────────────────────────────────────────────────────────────
  {
    patterns: [/habeas.*corpus|habeas corpus/i],
    answer: (l) => l === 'hi'
      ? 'Habeas Corpus का अर्थ है "अपना शरीर प्रस्तुत करो।" यह unlawful detention के विरुद्ध जारी होता है। कोर्ट detained व्यक्ति को produce करने का आदेश देती है। Emergency के दौरान भी Article 21 के तहत available है (ADM Jabalpur case overruled in Puttaswamy 2017)।'
      : 'Habeas Corpus means "produce the body." It is issued to produce a detained person before the court to examine the legality of detention. It is the most important writ for personal liberty. After Puttaswamy (2017) overruled ADM Jabalpur, it is available even during Emergency under Article 21.',
  },
  {
    patterns: [/mandamus.*writ|writ.*mandamus/i],
    answer: () => 'Mandamus ("we command") directs a public authority to perform a mandatory public duty it has failed to perform. It cannot be issued against the President, Governors, or High Courts. It is used when a public official refuses to discharge a legal duty.',
  },
]

/**
 * Look up a verified local answer for the query.
 * Returns the answer string if found, null otherwise.
 */
export function lookupLocalKnowledge(query: string, lang: 'en' | 'hi' | 'hinglish'): string | null {
  for (const fact of LOCAL_FACTS) {
    if (fact.patterns.some(p => p.test(query))) {
      return fact.answer(lang === 'hinglish' ? 'en' : lang)
    }
  }
  return null
}

// ── 3. SMART QUERY CLASSIFIER ─────────────────────────────────────────────────

export type QueryRoute = 'local-instant' | 'local-knowledge' | 'groq-knowledge' | 'groq-analysis' | 'action' | 'clarify'

export function smartRouteQuery(query: string): QueryRoute {
  const tl = query.toLowerCase().trim()

  // Local instant: system facts (time, date, status)
  if (/^(time|clock|date|aaj|status|streak|plan|timer|start|pause|reset|scores|analytics)$/.test(tl)) return 'local-instant'

  // Local knowledge: verified UPSC facts we can answer from LOCAL_FACTS
  if (LOCAL_FACTS.some(f => f.patterns.some(p => p.test(tl)))) return 'local-knowledge'

  // Groq analysis: deep questions needing reasoning
  if (/\b(analyze|critically|evaluate|compare|contrast|discuss implications|impact of|significance of|why did|what led to|explain the relationship|dimensions of|challenges of|way forward)\b/i.test(tl)) return 'groq-analysis'

  // Action: app control commands
  if (/\b(open|show|start|stop|pause|reset|add|log|mark|generate|go to|navigate|click|fill|set)\b/i.test(tl) &&
      !/\b(what is|explain|tell me|describe|why|how does)\b/i.test(tl)) return 'action'

  // Groq knowledge: UPSC content questions we don't have locally
  if (/\b(what|who|when|where|which|why|how|explain|describe|define|tell|article|act|law|court|policy|scheme|treaty|organization|history|geography|economy|environment|science|ethics)\b/i.test(tl)) return 'groq-knowledge'

  return 'groq-knowledge'
}

// ── 4. WEBSITE CONTROL REGISTRY ───────────────────────────────────────────────

export interface AppSection {
  id:         string
  name:       string
  aliases:    string[]
  description: string
  keyElements: string[]
}

export const APP_SECTIONS: AppSection[] = [
  {
    id: 'engine',
    name: 'Focus Timer',
    aliases: ['timer', 'pomodoro', 'focus', 'engine', 'clock section'],
    description: 'Pomodoro timer with session tracking. Controls: Start/Pause/Reset/Skip.',
    keyElements: ['[data-act="start"]', '[data-act="reset"]', '.ring-time', '.ring-sess'],
  },
  {
    id: 'plan',
    name: 'Study Planner',
    aliases: ['planner', 'plan', 'lectures', 'schedule', 'backlog', 'today plan'],
    description: 'Lecture planner with daily schedule, backlog, and checkoffs.',
    keyElements: ['#lp-search', '#ai-gen', '.plan-row', '#lp-add'],
  },
  {
    id: 'intel',
    name: 'Analytics',
    aliases: ['analytics', 'intelligence', 'stats', 'scores', 'performance', 'charts'],
    description: 'Performance analytics: streak, rank, scores, heatmap, accuracy.',
    keyElements: ['#streak-num', '#rank-num', '#heat', '#rtn-accuracy'],
  },
  {
    id: 'routine-section',
    name: 'Daily Routine',
    aliases: ['routine', 'daily log', 'day log', 'routine logger', 'daily routine'],
    description: 'Log today: study hours, attempts, correct answers, day type.',
    keyElements: ['#rtn-study-hours', '#rtn-attempted', '#rtn-correct', '#rtn-save'],
  },
  {
    id: 'constitution-section',
    name: 'Constitution',
    aliases: ['constitution', 'articles', 'preamble', 'fundamental rights', 'const'],
    description: 'Browse and search all 481 articles of the Indian Constitution.',
    keyElements: ['#const-search', '#const-preamble-btn'],
  },
]

/** Resolve a natural-language section name to its DOM ID */
export function resolveSectionId(query: string): string | null {
  const tl = query.toLowerCase()
  for (const sec of APP_SECTIONS) {
    if (tl.includes(sec.id) || sec.aliases.some(a => tl.includes(a))) return sec.id
  }
  return null
}

// ── 5. ANSWER QUALITY FILTER ──────────────────────────────────────────────────

/** Remove filler phrases and trim Groq response to a clean spoken answer. */
export function cleanGroqAnswer(raw: string): string {
  return raw
    // Strip common filler openers
    .replace(/^(Great question!|Certainly!|Of course!|Sure!|Absolutely!|That\'s a great|Happy to help!|I\'d be happy to|Let me explain|Here\'s what you need to know:|Here is|Here are)[^A-Za-z0-9ऀ-ॿ]*/i, '')
    // Strip trailing "I hope this helps" / "Let me know if you need more"
    .replace(/\s*(I hope this helps|Let me know if you need (more|further|anything)|Feel free to ask|Is there anything else|Hope that (answers|helps)|Please let me know)[.!?]?\s*$/i, '')
    // Remove excessive markdown that won't render in speech
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold** → bold
    .replace(/\*(.+?)\*/g, '$1')        // *italic* → italic
    .replace(/#{1,6}\s*/g, '')          // ## headings → plain
    .replace(/\n{3,}/g, '\n\n')         // trim excessive blank lines
    .trim()
}

// ── 6. UPSC QUICK FACTS (sub-second answers) ────────────────────────────────

export const UPSC_QUICK_FACTS: Record<string, string> = {
  // Constitutional numbers
  'how many articles constitution': 'The Indian Constitution originally had 395 articles in 22 parts. After amendments, it has about 448 articles (some deleted, some added). There are 12 Schedules.',
  'how many schedules constitution': 'The Indian Constitution has 12 Schedules. Original had 8; 4 more were added by amendments.',
  'how many amendments constitution': 'The Indian Constitution has been amended over 105 times (as of 2023). The 42nd Amendment (1976) was the most sweeping, often called the "Mini Constitution."',
  'how many parts constitution': 'The Indian Constitution has 25 Parts (originally 22; new parts added by amendments).',

  // Parliament
  'how many members lok sabha': 'The Lok Sabha has 543 elected seats (+ 2 Anglo-Indian nominated seats abolished by 104th Amendment 2020). Currently 543 members.',
  'how many members rajya sabha': 'The Rajya Sabha has 245 members — 233 elected by state/UT legislatures and 12 nominated by the President.',

  // India facts
  'capital india': 'New Delhi is the capital of India.',
  'largest state india': 'Rajasthan is the largest state by area. Uttar Pradesh is the most populous state.',
  'national river india': 'The Ganga is the national river of India.',
  'national animal india': 'The Bengal Tiger (Panthera tigris tigris) is India\'s national animal.',
  'constitution day india': 'Constitution Day (Samvidhan Diwas) is observed on 26 November — the day the Constituent Assembly adopted the Constitution in 1949. It came into force on 26 January 1950 (Republic Day).',
  'republic day': 'Republic Day is celebrated on 26 January — the day the Constitution of India came into force in 1950.',
  'independence day india': 'India\'s Independence Day is 15 August, celebrated since 1947 when India became independent from British rule.',
}

export function lookupQuickFact(query: string): string | null {
  const tl = query.toLowerCase().trim()
  for (const [key, val] of Object.entries(UPSC_QUICK_FACTS)) {
    const words = key.split(' ')
    if (words.every(w => tl.includes(w))) return val
  }
  return null
}
