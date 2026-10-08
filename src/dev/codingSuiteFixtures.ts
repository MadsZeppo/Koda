import type { FakeScript } from "./fakeProvider.js";

export interface CodingScenario {
  id: string;
  requirement: string;
  implementation: string;
  cases: [unknown[], unknown][];
  create?: boolean;
  addTests?: boolean;
  progressive?: boolean;
  invalidArgs?: unknown[][];
}
// These expected values are kept outside each candidate repo by the harness.
export const codingScenarios: CodingScenario[] = [
  {
    id: "sum",
    requirement: "Return the sum of two numbers, including negatives.",
    implementation: "(a,b)=>a+b",
    cases: [
      [[2, 3], 5],
      [[-4, 1], -3],
    ],
  },
  {
    id: "clamp",
    requirement: "Clamp a number to inclusive minimum and maximum bounds.",
    implementation: "(v,min,max)=>Math.min(max,Math.max(min,v))",
    cases: [
      [[9, 0, 5], 5],
      [[-2, 0, 5], 0],
      [[3, 0, 5], 3],
    ],
  },
  {
    id: "slug",
    requirement:
      "Trim, lowercase and replace consecutive whitespace with a hyphen.",
    implementation: "s=>s.trim().toLowerCase().replace(/\\s+/g,'-')",
    cases: [[[" Hello  World "], "hello-world"]],
  },
  {
    id: "deduplicate",
    requirement:
      "Remove duplicate array values while preserving first occurrence order.",
    implementation: "xs=>[...new Set(xs)]",
    cases: [
      [[[3, 1, 3, 2, 1]], [3, 1, 2]],
      [[[]], []],
    ],
  },
  {
    id: "chunk",
    invalidArgs: [
      [[], 0],
      [[], -1],
    ],
    requirement:
      "Split an array into chunks of positive integer size; reject non-positive sizes with RangeError.",
    implementation:
      "(xs,n)=>{if(!Number.isInteger(n)||n<=0)throw new RangeError();return Array.from({length:Math.ceil(xs.length/n)},(_,i)=>xs.slice(i*n,(i+1)*n))}",
    cases: [
      [
        [[1, 2, 3, 4, 5], 2],
        [[1, 2], [3, 4], [5]],
      ],
      [[[], 2], []],
    ],
  },
  {
    id: "median",
    requirement:
      "Return numeric median without mutating the input; return null for empty arrays.",
    implementation:
      "xs=>{if(!xs.length)return null;const a=[...xs].sort((a,b)=>a-b),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2}",
    cases: [
      [[[10, 2, 4]], 4],
      [[[1, 9]], 5],
      [[[]], null],
    ],
  },
  {
    id: "count-words",
    requirement:
      "Count nonempty whitespace-separated words; whitespace-only input has zero words.",
    implementation: "s=>s.trim()?s.trim().split(/\\s+/).length:0",
    cases: [
      [[" a  b\nc "], 3],
      [["  "], 0],
    ],
  },
  {
    id: "initials",
    requirement:
      "Return uppercase first letters of whitespace-separated nonempty name parts. Empty and whitespace-only names must return an empty string.",
    implementation:
      "s=>s.trim().split(/\\s+/).filter(Boolean).map(x=>x[0].toUpperCase()).join('')",
    cases: [
      [["Ada Lovelace"], "AL"],
      [["  "], ""],
    ],
  },
  {
    id: "extension",
    requirement:
      "Return the lowercase extension of the last path component without the leading dot; no dot means empty string.",
    implementation:
      "s=>{const n=s.split('/').pop();const i=n.lastIndexOf('.');return i<0?'':n.slice(i+1).toLowerCase()}",
    cases: [
      [["a/b.TXT"], "txt"],
      [["folder.x/file"], ""],
    ],
  },
  {
    id: "escape-html",
    requirement:
      "Escape ampersand as &amp;, less-than as &lt;, greater-than as &gt; and double quote as &quot; in HTML text.",
    implementation:
      "s=>s.replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]))",
    cases: [[['<b title="x">&'], "&lt;b title=&quot;x&quot;&gt;&amp;"]],
  },
  {
    id: "query",
    requirement:
      "Encode an object as key=value pairs joined by &, without a leading question mark, in sorted key order with percent-encoded keys and values (spaces become %20).",
    implementation:
      "o=>Object.keys(o).sort().map(k=>encodeURIComponent(k)+'='+encodeURIComponent(o[k])).join('&')",
    cases: [[[{ z: "a b", a: "&" }], "a=%26&z=a%20b"]],
  },
  {
    id: "redact",
    requirement:
      "Return a new object with secret and token keys removed, preserving other keys.",
    implementation:
      "o=>Object.fromEntries(Object.entries(o).filter(([k])=>!['secret','token'].includes(k)))",
    cases: [[[{ secret: "x", token: "y", name: "Ada" }], { name: "Ada" }]],
  },
  {
    id: "group",
    requirement:
      "Group records by their category into an object whose keys are categories and values are arrays of the original full records in input order; return an empty object for no records.",
    implementation:
      "xs=>xs.reduce((o,x)=>{(o[x.category]??=[]).push(x);return o},{})",
    cases: [
      [
        [
          [
            { category: "a", v: 1 },
            { category: "a", v: 2 },
          ],
        ],
        {
          a: [
            { category: "a", v: 1 },
            { category: "a", v: 2 },
          ],
        },
      ],
      [[[]], {}],
    ],
  },
  {
    id: "pagination",
    invalidArgs: [
      [[], 0, 2],
      [[], 1, 0],
    ],
    requirement:
      "fn(array,page,size): Return a one-based page from an array; reject page or size below one with RangeError.",
    implementation:
      "(xs,page,size)=>{if(page<1||size<1)throw new RangeError();return xs.slice((page-1)*size,page*size)}",
    cases: [
      [
        [[1, 2, 3, 4, 5], 2, 2],
        [3, 4],
      ],
      [[[1], 3, 2], []],
    ],
  },
  {
    id: "intersection",
    requirement: "Return unique common values in the first array order.",
    implementation: "(a,b)=>[...new Set(a)].filter(x=>b.includes(x))",
    cases: [
      [
        [
          [3, 1, 3, 2],
          [2, 3],
        ],
        [3, 2],
      ],
    ],
  },
  {
    id: "zip",
    requirement: "Zip two arrays into pairs, stopping at the shorter array.",
    implementation: "(a,b)=>a.slice(0,b.length).map((x,i)=>[x,b[i]])",
    cases: [[[[1, 2], ["a"]], [[1, "a"]]]],
  },
  {
    id: "flatten",
    requirement: "Flatten exactly one level of nested arrays.",
    implementation: "xs=>xs.flat(1)",
    cases: [[[[1, [2, [3]]]], [1, 2, [3]]]],
  },
  {
    id: "partition",
    requirement:
      "fn(numbers): return the tuple [evenNumbers,oddNumbers], preserving order in each array.",
    implementation: "xs=>[xs.filter(x=>x%2===0),xs.filter(x=>x%2!==0)]",
    cases: [
      [
        [[-3, 2, 1, 4]],
        [
          [2, 4],
          [-3, 1],
        ],
      ],
    ],
  },
  {
    id: "range",
    requirement:
      "Return integers from inclusive start to exclusive end; descending or equal bounds return empty.",
    implementation: "(a,b)=>Array.from({length:Math.max(0,b-a)},(_,i)=>a+i)",
    cases: [
      [
        [2, 5],
        [2, 3, 4],
      ],
      [[5, 2], []],
    ],
  },
  {
    id: "factorial",
    invalidArgs: [[-1], [1.5]],
    requirement:
      "fn(n): Return factorial of a nonnegative integer, including factorial(0)=1; reject invalid input with RangeError.",
    implementation:
      "n=>{if(!Number.isInteger(n)||n<0)throw new RangeError();let r=1;for(let i=2;i<=n;i++)r*=i;return r}",
    cases: [
      [[0], 1],
      [[5], 120],
    ],
  },
  {
    id: "leap-year",
    requirement:
      "Determine Gregorian leap years using the divisibility-by-4, 100 and 400 rules.",
    implementation: "y=>y%4===0&&(y%100!==0||y%400===0)",
    cases: [
      [[2000], true],
      [[1900], false],
      [[2024], true],
    ],
  },
  {
    id: "retry-delay",
    requirement:
      "fn(base,attempt,maximum): Return exponential retry delay base*2^attempt capped at maximum.",
    implementation: "(base,attempt,max)=>Math.min(max,base*2**attempt)",
    cases: [
      [[100, 3, 500], 500],
      [[100, 1, 500], 200],
    ],
  },
  {
    id: "currency",
    requirement:
      "Convert an integer number of cents to a decimal string with exactly two places, including negatives.",
    implementation: "n=>(n/100).toFixed(2)",
    cases: [
      [[123], "1.23"],
      [[-5], "-0.05"],
      [[0], "0.00"],
    ],
  },
  {
    id: "normalize-email",
    requirement: "Trim and lowercase an email string.",
    implementation: "s=>s.trim().toLowerCase()",
    cases: [[[" Ada@Example.COM "], "ada@example.com"]],
  },
  {
    id: "safe-json",
    requirement: "Parse JSON, returning null on malformed input.",
    implementation: "s=>{try{return JSON.parse(s)}catch{return null}}",
    cases: [
      [['{"ok":true}'], { ok: true }],
      [["{"], null],
    ],
  },
  {
    id: "merge",
    requirement:
      "Merge two objects into a new object with the second object winning duplicate keys.",
    implementation: "(a,b)=>({...a,...b})",
    cases: [[[{ a: 1, b: 2 }, { b: 3 }], { a: 1, b: 3 }]],
  },
  {
    id: "sort-records",
    requirement:
      "Return records sorted ascending by numeric score without mutating input.",
    implementation: "xs=>[...xs].sort((a,b)=>a.score-b.score)",
    cases: [[[[{ score: 10 }, { score: 2 }]], [{ score: 2 }, { score: 10 }]]],
  },
  {
    id: "unique-by-id",
    requirement: "Keep the first record for each id in original order.",
    implementation:
      "xs=>{const seen=new Set();return xs.filter(x=>{if(seen.has(x.id))return false;seen.add(x.id);return true})}",
    cases: [
      [
        [
          [
            { id: 1, v: "a" },
            { id: 1, v: "b" },
            { id: 2, v: "c" },
          ],
        ],
        [
          { id: 1, v: "a" },
          { id: 2, v: "c" },
        ],
      ],
    ],
  },
  {
    id: "average",
    requirement: "Return arithmetic mean or null for empty input.",
    implementation: "xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null",
    cases: [
      [[[2, 4, 9]], 5],
      [[[]], null],
    ],
  },
  {
    id: "duration",
    requirement:
      "Format nonnegative seconds as minutes:two-digit-seconds (e.g. 125 -> 2:05).",
    implementation: "n=>Math.floor(n/60)+':'+String(n%60).padStart(2,'0')",
    cases: [
      [[125], "2:05"],
      [[0], "0:00"],
    ],
  },
].map((scenario, index) => ({
  ...scenario,
  create: index < 3,
  addTests: index >= 3 && index < 9,
  progressive: index >= 9 && index < 12,
})) as CodingScenario[];

export function scenarioFixture(s: CodingScenario) {
  const source = `src/${s.id}.cjs`,
    testPath = `tests/${s.id}.test.cjs`;
  const baseline = "module.exports=()=>null;\n",
    final = `module.exports=${s.implementation};\n`;
  // Publish return shape as API specification, never expected values or the
  // reference implementation. The independent value oracle stays external.
  const resultTypes=[...new Set(s.cases.map(([,value])=>value===null?'null':Array.isArray(value)?'array':typeof value))];
  const returnContract=`Return type: ${resultTypes.join(' or ')}. Return the specified result itself, not a wrapper or records used to calculate it.`;
  const shapeChecks=s.cases.length ? `test('public return contract',()=>{const result=fn(...${JSON.stringify(s.cases[0]![0])});const shape=result===null?'null':Array.isArray(result)?'array':typeof result;a.ok(${JSON.stringify(resultTypes)}.includes(shape),'unexpected return shape: '+shape);});\n` : '';
  const contract = `const {test}=require('node:test');const a=require('node:assert/strict');const fn=require('../${source}');test('export',()=>a.equal(typeof fn,'function'));\n` + shapeChecks;
  const assertions =
    s.cases
      .map(
        ([args, expected]) =>
          `{const args=${JSON.stringify(args)},before=structuredClone(args);a.deepEqual(fn(...args),${JSON.stringify(expected)});a.deepEqual(args,before,'input must remain unchanged');}`,
      )
      .join("\n") +
    (s.invalidArgs ?? [])
      .map((args) => `a.throws(()=>fn(...${JSON.stringify(args)}),RangeError);`)
      .join("\n");
  const testContent =
    contract + `test('required behavior',()=>{${assertions}});\n`;
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      scripts: {
        test: "node --test tests/*.test.cjs",
        typecheck: `node --check ${source}`,
      },
    }),
    [testPath]: contract,
  };
  if (!s.create) files[source] = baseline;
  const task = `${s.create ? "Create" : "Modify"} ${source}. Export a CommonJS function. ${returnContract} ${s.requirement} Do not mutate input arguments. ${s.addTests ? `Add regression tests in ${testPath}, including legal empty inputs and boundary cases covered by the contract.` : "Preserve existing tests."} Make the smallest change and run the relevant tests and syntax check.`;
  const steps: FakeScript["steps"] = [
    {
      stage: "planner",
      json: {
        taskSummary: task,
        acceptanceCriteria: [s.requirement],
        subtasks: [
          {
            id: "implementation",
            title: s.id,
            objective: task,
            likelyReadPaths: Object.keys(files),
            likelyWritePaths: [source, ...(s.addTests ? [testPath] : [])],
            dependsOn: [],
            integrationContract: s.requirement,
            verificationCommands: [],
            estimatedDifficulty: "normal",
            parallelSafe: false,
          },
        ],
      },
    },
  ];
  if (s.progressive)
    steps.push({
      stage: "worker",
      toolCalls: [
        { name: "list_files", arguments: {} },
        { name: "search_code", arguments: { query: "module.exports" } },
      ],
    });
  steps.push({
    stage: "worker",
    toolCalls: [
      {
        name: "read_file",
        arguments: { path: s.create ? "package.json" : source },
      },
    ],
  });
  steps.push({
    stage: "worker",
    toolCalls: [
      { name: "write_file", arguments: { path: source, content: final } },
      ...(s.addTests
        ? [
            {
              name: "write_file",
              arguments: { path: testPath, content: testContent },
            },
          ]
        : []),
    ],
  });
  steps.push({ stage: "worker", content: "Implementation complete" });
  steps.push(
    ...Array.from({ length: 6 }, () => ({
      stage: "review" as const,
      review: {
        passed: true,
        evidence:
          "Scripted candidate satisfies the behavior; real checks and independent acceptance run separately",
      },
    })),
  );
  return {
    source,
    testPath,
    files,
    task,
    script: { steps },
    acceptance: `const a=require('node:assert/strict');const fn=require(process.argv[1]);${assertions}`,
  };
}
