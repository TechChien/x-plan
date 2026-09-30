/**
 * The Brief's output language is chosen by the user (config `outputLanguage` or `--lang`), English by default,
 * and enforced by code: models were seen deciding "write in English" in their reasoning and then writing Chinese.
 */
export const OUTPUT_LANGUAGES = ["en", "zh", "cn"] as const;
export type OutputLanguage = (typeof OUTPUT_LANGUAGES)[number];

/** How the language is named in prompts and feedback. */
export const LANGUAGE_NAMES: Record<OutputLanguage, string> = {
  en: "English",
  zh: "Traditional Chinese (繁體中文)",
  cn: "Simplified Chinese (简体中文)",
};

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

/**
 * Simplified/Traditional pairs whose characters belong to one script only. Characters that are valid in both
 * scripts (后, 里, 面, 准, 范, 余, 并 ...) are left out so that correct text is never flagged.
 */
const PAIRS =
  "这這们們说說为為时時个個来來对對发發应應该該与與规規则則订訂货貨费費两兩会會过過还還进進实實现現务務问問题題关關从從动動处處员員单單" +
  "类類区區无無称稱页頁数數据據设設计計户戶帐帳账賬号號码碼购購买買卖賣价價钱錢银銀网網络絡电電话話视視频頻图圖书書学學习習语語读讀" +
  "写寫认認识識记記录錄标標质質检檢测測试試验驗证證确確决決条條项項统統权權组組织織级級结結构構态態览覽择擇创創删刪编編辑輯输輸转轉换換" +
  "载載链鏈键鍵错錯误誤报報响響请請访訪册冊显顯线線连連仅僅状狀况況场場业業历歷旧舊执執运運维維护護备備环環节節点點击擊触觸间間长長" +
  "边邊际際围圍开開闭閉启啟负負导導签簽审審让讓给給达達满滿减減总總额額汇匯币幣种種优優严嚴紧緊灵靈变變调調询詢";

const SIMPLIFIED_ONLY = new Set([...PAIRS].filter((_, i) => i % 2 === 0));
const TRADITIONAL_ONLY = new Set([...PAIRS].filter((_, i) => i % 2 === 1));

/** Free-text fields: long English prose there means the item was not written in Chinese. */
const PROSE_FIELDS = new Set(["description", "question", "reason", "rule", "requirement", "constraint", "assumption", "rationale", "conflict", "item", "definition"]);
const MIN_PROSE_WORDS = 8;

/** Kept exactly as the documents write them, whatever the output language. */
const VERBATIM_FIELDS = new Set(["evidence", "id", "term", "aliases"]);

/**
 * Fields of one item that are not in `lang`. Evidence, ids and glossary terms/aliases are skipped: they are
 * copied from the documents. English output must contain no CJK; Chinese output must not use the other
 * script's characters, nor leave a prose field in English.
 */
export function languageErrors(item: unknown, lang: OutputLanguage): string[] {
  const wrong = new Set<string>();
  const walk = (value: unknown, field: string) => {
    if (typeof value === "string") {
      if (!matches(value, lang, field)) wrong.add(field);
    } else if (Array.isArray(value)) value.forEach((v) => walk(v, field));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) if (!VERBATIM_FIELDS.has(k)) walk(v, field || k);
    }
  };
  walk(item, "");
  if (!wrong.size) return [];
  return [`not written in ${LANGUAGE_NAMES[lang]}: ${[...wrong].join(", ")}`];
}

function matches(text: string, lang: OutputLanguage, field: string): boolean {
  if (lang === "en") return !CJK.test(text);
  const foreign = lang === "zh" ? SIMPLIFIED_ONLY : TRADITIONAL_ONLY;
  if ([...text].some((c) => foreign.has(c))) return false;
  if (PROSE_FIELDS.has(field) && !CJK.test(text)) return (text.match(/[A-Za-z]+/g) ?? []).length < MIN_PROSE_WORDS;
  return true;
}
