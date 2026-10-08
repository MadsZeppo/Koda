import type { CodingScenario } from "./codingSuiteFixtures.js";

export const hardCodingScenarios: CodingScenario[] = [
  {
    "id": "hard-deep-flatten",
    "requirement": "fn(array): recursively flatten nested arrays of arbitrary depth, preserving primitive order. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "xs=>xs.flat(Infinity)",
    "cases": [
      [
        [
          [
            1,
            [
              2,
              [
                3
              ]
            ],
            []
          ]
        ],
        [
          1,
          2,
          3
        ]
      ],
      [
        [
          []
        ],
        []
      ]
    ],
    "create": true,
    "addTests": true,
    "progressive": true
  },
  {
    "id": "hard-stable-frequency",
    "requirement": "fn(array): return [value,count] pairs in order of first appearance; primitive values only. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "xs=>[...xs.reduce((m,x)=>m.set(x,(m.get(x)||0)+1),new Map())]",
    "cases": [
      [
        [
          [
            "b",
            "a",
            "b",
            "c",
            "a"
          ]
        ],
        [
          [
            "b",
            2
          ],
          [
            "a",
            2
          ],
          [
            "c",
            1
          ]
        ]
      ],
      [
        [
          []
        ],
        []
      ]
    ],
    "create": true,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-rolling-average",
    "requirement": "fn(numbers, window): return averages for every complete sliding window. Return [] if window exceeds length; window is a positive integer. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "(xs,w)=>xs.slice(w-1).map((_,i)=>xs.slice(i,i+w).reduce((a,b)=>a+b,0)/w)",
    "cases": [
      [
        [
          [
            2,
            4,
            6,
            8
          ],
          2
        ],
        [
          3,
          5,
          7
        ]
      ],
      [
        [
          [
            1
          ],
          2
        ],
        []
      ]
    ],
    "create": true,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-merge-intervals",
    "requirement": "fn(intervals): sort and merge overlapping or touching inclusive [start,end] intervals. Preserve inputs. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "xs=>[...xs].sort((a,b)=>a[0]-b[0]).reduce((r,x)=>{const p=r.at(-1);if(p&&x[0]<=p[1])p[1]=Math.max(p[1],x[1]);else r.push([...x]);return r},[])",
    "cases": [
      [
        [
          [
            [
              5,
              7
            ],
            [
              1,
              3
            ],
            [
              3,
              6
            ]
          ]
        ],
        [
          [
            1,
            7
          ]
        ]
      ],
      [
        [
          []
        ],
        []
      ]
    ],
    "create": true,
    "addTests": true,
    "progressive": true
  },
  {
    "id": "hard-binary-search-first",
    "requirement": "fn(sortedNumbers,target): return first matching index or -1. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "(xs,t)=>{let l=0,r=xs.length;while(l<r){const m=(l+r)>>1;if(xs[m]<t)l=m+1;else r=m}return xs[l]===t?l:-1}",
    "cases": [
      [
        [
          [
            1,
            2,
            2,
            4
          ],
          2
        ],
        1
      ],
      [
        [
          [
            1,
            3
          ],
          2
        ],
        -1
      ],
      [
        [
          [],
          1
        ],
        -1
      ]
    ],
    "create": true,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-matrix-transpose",
    "requirement": "fn(matrix): transpose a rectangular matrix; empty matrix returns []. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "xs=>xs.length?xs[0].map((_,i)=>xs.map(r=>r[i])):[]",
    "cases": [
      [
        [
          [
            [
              1,
              2,
              3
            ],
            [
              4,
              5,
              6
            ]
          ]
        ],
        [
          [
            1,
            4
          ],
          [
            2,
            5
          ],
          [
            3,
            6
          ]
        ]
      ],
      [
        [
          []
        ],
        []
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-rotate-matrix",
    "requirement": "fn(squareMatrix): rotate clockwise 90 degrees without mutation; [] returns []. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "xs=>xs.length?xs[0].map((_,i)=>xs.map(r=>r[i]).reverse()):[]",
    "cases": [
      [
        [
          [
            [
              1,
              2
            ],
            [
              3,
              4
            ]
          ]
        ],
        [
          [
            3,
            1
          ],
          [
            4,
            2
          ]
        ]
      ],
      [
        [
          []
        ],
        []
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": true
  },
  {
    "id": "hard-run-length-encode",
    "requirement": "fn(string): return [character,count] pairs for consecutive runs; ASCII only. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "s=>[...s].reduce((r,c)=>{if(r.at(-1)?.[0]===c)r.at(-1)[1]++;else r.push([c,1]);return r},[])",
    "cases": [
      [
        [
          "aaabbcca"
        ],
        [
          [
            "a",
            3
          ],
          [
            "b",
            2
          ],
          [
            "c",
            2
          ],
          [
            "a",
            1
          ]
        ]
      ],
      [
        [
          ""
        ],
        []
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-run-length-decode",
    "requirement": "fn(pairs): concatenate each character repeated its count; counts are nonnegative integers. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "xs=>xs.map(([c,n])=>c.repeat(n)).join('')",
    "cases": [
      [
        [
          [
            [
              "a",
              3
            ],
            [
              "b",
              0
            ],
            [
              "c",
              2
            ]
          ]
        ],
        "aaacc"
      ],
      [
        [
          []
        ],
        ""
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-balanced-brackets",
    "requirement": "fn(string): validate matching (), [] and {}; ignore other characters. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "s=>{const stack=[],pairs={')':'(',']':'[','}':'{'};for(const c of s){if('([{'.includes(c))stack.push(c);else if(c in pairs&&stack.pop()!==pairs[c])return false}return !stack.length}",
    "cases": [
      [
        [
          "a([{}])"
        ],
        true
      ],
      [
        [
          "([)]"
        ],
        false
      ],
      [
        [
          "("
        ],
        false
      ],
      [
        [
          ""
        ],
        true
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": true
  },
  {
    "id": "hard-levenshtein",
    "requirement": "fn(a,b): return case-sensitive Levenshtein edit distance for ASCII strings. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "(a,b)=>{let row=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]!==b[j-1]));row=next}return row[b.length]}",
    "cases": [
      [
        [
          "kitten",
          "sitting"
        ],
        3
      ],
      [
        [
          "",
          "abc"
        ],
        3
      ],
      [
        [
          "same",
          "same"
        ],
        0
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-longest-common-prefix",
    "requirement": "fn(strings): return the longest shared prefix, or empty string for []. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "xs=>{let p=xs[0]||'';for(const s of xs)while(!s.startsWith(p))p=p.slice(0,-1);return p}",
    "cases": [
      [
        [
          [
            "flower",
            "flow",
            "flight"
          ]
        ],
        "fl"
      ],
      [
        [
          []
        ],
        ""
      ],
      [
        [
          [
            "abc",
            "xyz"
          ]
        ],
        ""
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-anagram-groups",
    "requirement": "fn(strings): group case-sensitive ASCII anagrams; groups and items follow first occurrence order. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "xs=>[...xs.reduce((m,s)=>{const k=[...s].sort().join('');if(!m.has(k))m.set(k,[]);m.get(k).push(s);return m},new Map()).values()]",
    "cases": [
      [
        [
          [
            "eat",
            "tea",
            "tan",
            "ate",
            "nat",
            "bat"
          ]
        ],
        [
          [
            "eat",
            "tea",
            "ate"
          ],
          [
            "tan",
            "nat"
          ],
          [
            "bat"
          ]
        ]
      ],
      [
        [
          []
        ],
        []
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": true
  },
  {
    "id": "hard-cart-totals",
    "requirement": "fn(items): each item has quantity and integer unitCents; return {subtotalCents,itemCount}, counting quantity, without mutation. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "xs=>xs.reduce((r,x)=>({subtotalCents:r.subtotalCents+x.quantity*x.unitCents,itemCount:r.itemCount+x.quantity}),{subtotalCents:0,itemCount:0})",
    "cases": [
      [
        [
          [
            {
              "quantity": 2,
              "unitCents": 125
            },
            {
              "quantity": 3,
              "unitCents": 10
            }
          ]
        ],
        {
          "subtotalCents": 280,
          "itemCount": 5
        }
      ],
      [
        [
          []
        ],
        {
          "subtotalCents": 0,
          "itemCount": 0
        }
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-inventory-reconcile",
    "requirement": "fn(stock,orders): return a new stock object subtracting each {sku,quantity}; absent SKUs start at zero; permit negative results. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "(stock,orders)=>orders.reduce((r,x)=>{r[x.sku]=(r[x.sku]||0)-x.quantity;return r},{...stock})",
    "cases": [
      [
        [
          {
            "a": 5
          },
          [
            {
              "sku": "a",
              "quantity": 2
            },
            {
              "sku": "b",
              "quantity": 1
            }
          ]
        ],
        {
          "a": 3,
          "b": -1
        }
      ],
      [
        [
          {},
          []
        ],
        {}
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-ranking",
    "requirement": "fn(records): records have id and score; return records with rank using competition ranking (1,1,3), descending score; preserve ties in input order. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "xs=>[...xs].sort((a,b)=>b.score-a.score).map((x,i,a)=>({...x,rank:a.findIndex(y=>y.score===x.score)+1}))",
    "cases": [
      [
        [
          [
            {
              "id": "a",
              "score": 5
            },
            {
              "id": "b",
              "score": 9
            },
            {
              "id": "c",
              "score": 9
            }
          ]
        ],
        [
          {
            "id": "b",
            "score": 9,
            "rank": 1
          },
          {
            "id": "c",
            "score": 9,
            "rank": 1
          },
          {
            "id": "a",
            "score": 5,
            "rank": 3
          }
        ]
      ],
      [
        [
          []
        ],
        []
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": true
  },
  {
    "id": "hard-csv-row",
    "requirement": "fn(fields): serialize one CSV row; quote fields containing comma, double quote, CR or LF; double embedded quotes; no trailing newline. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "xs=>xs.map(s=>/[\",\\r\\n]/.test(s)?'\"'+s.replace(/\"/g,'\"\"')+'\"':s).join(',')",
    "cases": [
      [
        [
          [
            "a",
            "b,c",
            "say \"hi\"",
            "x\ny"
          ]
        ],
        "a,\"b,c\",\"say \"\"hi\"\"\",\"x\ny\""
      ],
      [
        [
          []
        ],
        ""
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-parse-query-multi",
    "requirement": "fn(query): parse optional leading ?, URI decoding plus as space; repeated keys become arrays, singleton keys strings, missing value empty string. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "s=>{const r={};for(const [k,v] of new URLSearchParams(s)){if(k in r)r[k]=Array.isArray(r[k])?[...r[k],v]:[r[k],v];else r[k]=v}return r}",
    "cases": [
      [
        [
          "?a=1&a=2&b=hello+world&empty"
        ],
        {
          "a": [
            "1",
            "2"
          ],
          "b": "hello world",
          "empty": ""
        }
      ],
      [
        [
          ""
        ],
        {}
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-path-normalize",
    "requirement": "fn(path): normalize absolute POSIX paths, removing duplicate slashes, dot and parent segments; never traverse above root. Remove trailing slashes except for the root path itself. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "s=>{const r=[];for(const x of s.split('/')){if(x==='..')r.pop();else if(x&&x!=='.')r.push(x)}return '/'+r.join('/')}",
    "cases": [
      [
        [
          "/a//b/../c/./"
        ],
        "/a/c"
      ],
      [
        [
          "/../../x"
        ],
        "/x"
      ],
      [
        [
          "/"
        ],
        "/"
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": true
  },
  {
    "id": "hard-pagination-metadata",
    "requirement": "fn(items,page,size): positive integer page and size; return {items,page,totalPages,totalItems,hasNext,hasPrevious}; beyond-end pages yield empty items. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "(xs,p,n)=>({items:xs.slice((p-1)*n,p*n),page:p,totalPages:Math.ceil(xs.length/n),totalItems:xs.length,hasNext:p<Math.ceil(xs.length/n),hasPrevious:p>1})",
    "cases": [
      [
        [
          [
            1,
            2,
            3,
            4,
            5
          ],
          2,
          2
        ],
        {
          "items": [
            3,
            4
          ],
          "page": 2,
          "totalPages": 3,
          "totalItems": 5,
          "hasNext": true,
          "hasPrevious": true
        }
      ],
      [
        [
          [],
          1,
          3
        ],
        {
          "items": [],
          "page": 1,
          "totalPages": 0,
          "totalItems": 0,
          "hasNext": false,
          "hasPrevious": false
        }
      ],
      [
        [
          [
            1
          ],
          4,
          2
        ],
        {
          "items": [],
          "page": 4,
          "totalPages": 1,
          "totalItems": 1,
          "hasNext": false,
          "hasPrevious": true
        }
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-set-diff",
    "requirement": "fn(before,after): return {added,removed}; deduplicate, preserve first appearance in the respective array. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "(a,b)=>({added:[...new Set(b)].filter(x=>!a.includes(x)),removed:[...new Set(a)].filter(x=>!b.includes(x))})",
    "cases": [
      [
        [
          [
            1,
            2,
            2
          ],
          [
            2,
            3,
            3
          ]
        ],
        {
          "added": [
            3
          ],
          "removed": [
            1
          ]
        }
      ],
      [
        [
          [],
          []
        ],
        {
          "added": [],
          "removed": []
        }
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-histogram",
    "requirement": "fn(numbers,width): positive integer width; keys are floor(value/width)*width, counts include negative bins. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "(xs,w)=>xs.reduce((r,x)=>{const k=Math.floor(x/w)*w;r[k]=(r[k]||0)+1;return r},{})",
    "cases": [
      [
        [
          [
            -1,
            0,
            4,
            5,
            9,
            10
          ],
          5
        ],
        {
          "0": 2,
          "5": 2,
          "10": 1,
          "-5": 1
        }
      ],
      [
        [
          [],
          3
        ],
        {}
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": true
  },
  {
    "id": "hard-moving-dedup",
    "requirement": "fn(values,distance): suppress a value if it appears among the preceding distance INPUT positions; distance is nonnegative integer. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "(xs,n)=>xs.filter((x,i)=>!xs.slice(Math.max(0,i-n),i).includes(x))",
    "cases": [
      [
        [
          [
            "a",
            "b",
            "a",
            "a",
            "c",
            "a"
          ],
          2
        ],
        [
          "a",
          "b",
          "c"
        ]
      ],
      [
        [
          [
            1,
            1,
            2
          ],
          0
        ],
        [
          1,
          1,
          2
        ]
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-nested-get",
    "requirement": "fn(object,path,fallback): path is array of keys; return fallback for absent own property; preserve null and false; empty path returns object. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "(o,p,f)=>{for(const k of p){if(o==null||!Object.prototype.hasOwnProperty.call(o,k))return f;o=o[k]}return o}",
    "cases": [
      [
        [
          {
            "a": {
              "b": null
            }
          },
          [
            "a",
            "b"
          ],
          "missing"
        ],
        null
      ],
      [
        [
          {},
          [
            "x"
          ],
          7
        ],
        7
      ],
      [
        [
          {
            "ok": false
          },
          [
            "ok"
          ],
          true
        ],
        false
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-pick-fields",
    "requirement": "fn(records,fields): return new records containing only existing own fields from fields; never invent absent fields. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "(xs,fields)=>xs.map(x=>Object.fromEntries(fields.filter(k=>Object.prototype.hasOwnProperty.call(x,k)).map(k=>[k,x[k]])))",
    "cases": [
      [
        [
          [
            {
              "a": 1,
              "b": 2
            },
            {
              "b": 3
            }
          ],
          [
            "a"
          ]
        ],
        [
          {
            "a": 1
          },
          {}
        ]
      ],
      [
        [
          [],
          [
            "a"
          ]
        ],
        []
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": true
  },
  {
    "id": "hard-event-summary",
    "requirement": "fn(events): each has type and amount; return sorted-by-type [{type,count,total}] summaries. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "xs=>{const m=new Map();for(const x of xs){const r=m.get(x.type)||{type:x.type,count:0,total:0};r.count++;r.total+=x.amount;m.set(x.type,r)}return [...m.values()].sort((a,b)=>a.type.localeCompare(b.type))}",
    "cases": [
      [
        [
          [
            {
              "type": "b",
              "amount": 2
            },
            {
              "type": "a",
              "amount": 4
            },
            {
              "type": "b",
              "amount": -1
            }
          ]
        ],
        [
          {
            "type": "a",
            "count": 1,
            "total": 4
          },
          {
            "type": "b",
            "count": 2,
            "total": 1
          }
        ]
      ],
      [
        [
          []
        ],
        []
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-roman-numerals",
    "requirement": "fn(n): convert integers 1..3999 into canonical uppercase Roman numerals with subtractive notation. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "n=>{let s='';for(const [v,t] of [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']])while(n>=v){s+=t;n-=v}return s}",
    "cases": [
      [
        [
          1994
        ],
        "MCMXCIV"
      ],
      [
        [
          4
        ],
        "IV"
      ],
      [
        [
          3999
        ],
        "MMMCMXCIX"
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-ipv4-number",
    "requirement": "fn(address): convert dotted IPv4 address into unsigned 32-bit numeric value; valid input only. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "s=>s.split('.').reduce((n,x)=>n*256+Number(x),0)",
    "cases": [
      [
        [
          "255.255.255.255"
        ],
        4294967295
      ],
      [
        [
          "127.0.0.1"
        ],
        2130706433
      ],
      [
        [
          "0.0.0.0"
        ],
        0
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": true
  },
  {
    "id": "hard-date-overlap",
    "requirement": "fn(intervals): half-open numeric intervals [start,end]; return maximum concurrent overlap; zero-length intervals ignored; end events before start at same time. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "xs=>{const es=xs.filter(([a,b])=>a<b).flatMap(([a,b])=>[[a,1],[b,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let n=0,max=0;for(const [,d] of es){n+=d;max=Math.max(max,n)}return max}",
    "cases": [
      [
        [
          [
            [
              1,
              3
            ],
            [
              3,
              5
            ],
            [
              2,
              4
            ],
            [
              4,
              4
            ]
          ]
        ],
        2
      ],
      [
        [
          []
        ],
        0
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  },
  {
    "id": "hard-dependency-order",
    "requirement": "fn(nodes,edges): edges [prerequisite,dependent]; return topological order, picking lexicographically smallest available node each step; return null on cycle. Nodes unique strings. Do not mutate any input argument. Use only built-in Node APIs, no dependencies. Include regression coverage for boundary cases and empty inputs where specified.",
    "implementation": "(nodes,edges)=>{const left=new Set(nodes),out=[];while(left.size){const next=[...left].sort().find(n=>!edges.some(([a,b])=>b===n&&left.has(a)));if(next===undefined)return null;left.delete(next);out.push(next)}return out}",
    "cases": [
      [
        [
          [
            "c",
            "b",
            "a"
          ],
          [
            [
              "a",
              "c"
            ],
            [
              "b",
              "c"
            ]
          ]
        ],
        [
          "a",
          "b",
          "c"
        ]
      ],
      [
        [
          [
            "a",
            "b"
          ],
          [
            [
              "a",
              "b"
            ],
            [
              "b",
              "a"
            ]
          ]
        ],
        null
      ],
      [
        [
          [],
          []
        ],
        []
      ]
    ],
    "create": false,
    "addTests": true,
    "progressive": false
  }
];
