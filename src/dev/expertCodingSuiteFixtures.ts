import type { CodingScenario } from "./codingSuiteFixtures.js";

// Reference implementations are used only by the fake provider. Live candidates
// receive contracts, never these solutions; acceptance runs outside their repos.
const scenarios: [string, string, string, CodingScenario["cases"]][] = [
  [
    "shortest-path",
    "fn(nodes,edges,start,end): directed unit-weight edges; return shortest distance, null if unreachable. All nodes exist; start=end returns 0.",
    "(ns,es,s,t)=>{const q=[[s,0]],seen=new Set([s]);for(const [n,d] of q){if(n===t)return d;for(const [a,b] of es)if(a===n&&!seen.has(b)){seen.add(b);q.push([b,d+1])}}return null}",
    [
      [
        [
          ["a", "b", "c"],
          [
            ["a", "b"],
            ["b", "c"],
          ],
          "a",
          "c",
        ],
        2,
      ],
      [[["a", "b"], [], "a", "b"], null],
      [[["a"], [], "a", "a"], 0],
    ],
  ],
  [
    "weighted-path",
    "fn(nodes,edges,start,end): directed [from,to,nonnegativeWeight] edges; minimum cost or null if unreachable.",
    "(ns,es,s,t)=>{const d=new Map(ns.map(n=>[n,Infinity]));d.set(s,0);for(let i=1;i<ns.length;i++)for(const [a,b,w] of es)d.set(b,Math.min(d.get(b),d.get(a)+w));return d.get(t)===Infinity?null:d.get(t)}",
    [
      [
        [
          ["a", "b", "c"],
          [
            ["a", "c", 9],
            ["a", "b", 2],
            ["b", "c", 3],
          ],
          "a",
          "c",
        ],
        5,
      ],
      [[["a", "b"], [], "a", "b"], null],
      [[["a"], [], "a", "a"], 0],
    ],
  ],
  [
    "connected-components",
    "fn(nodes,edges): undirected graph; return components sorted internally and by first member using ASCII order. Include isolated nodes.",
    "(ns,es)=>{const left=new Set(ns),out=[];while(left.size){const q=[left.values().next().value];left.delete(q[0]);for(const n of q)for(const [a,b] of es){const v=a===n?b:b===n?a:undefined;if(v!==undefined&&left.delete(v))q.push(v)}out.push(q.sort())}return out.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)}",
    [
      [
        [
          ["d", "c", "b", "a"],
          [
            ["b", "a"],
            ["c", "b"],
          ],
        ],
        [["a", "b", "c"], ["d"]],
      ],
      [[[], []], []],
    ],
  ],
  [
    "cycle-detection",
    "fn(nodes,edges): directed graph; return true if ANY component has a cycle, including self-loops.",
    "(ns,es)=>{const done=new Set(),active=new Set();const visit=n=>{if(active.has(n))return true;if(done.has(n))return false;active.add(n);for(const [a,b] of es)if(a===n&&visit(b))return true;active.delete(n);done.add(n);return false};return ns.some(visit)}",
    [
      [
        [
          ["a", "b", "c"],
          [
            ["b", "c"],
            ["c", "b"],
          ],
        ],
        true,
      ],
      [[["a"], [["a", "a"]]], true],
      [[["a", "b"], [["a", "b"]]], false],
      [[[], []], false],
    ],
  ],
  [
    "coin-change",
    "fn(coins,amount): positive integer denominations, nonnegative amount; minimum coin count for unlimited coins, or -1 if impossible.",
    "(cs,n)=>{const d=Array(n+1).fill(Infinity);d[0]=0;for(let i=1;i<=n;i++)for(const c of cs)if(c<=i)d[i]=Math.min(d[i],d[i-c]+1);return d[n]===Infinity?-1:d[n]}",
    [
      [[[1, 3, 4], 6], 2],
      [[[2], 3], -1],
      [[[], 0], 0],
    ],
  ],
  [
    "knapsack",
    "fn(items,capacity): items {weight,value}, positive integer weights; maximum value with each item used at most once.",
    "(xs,c)=>{const d=Array(c+1).fill(0);for(const x of xs)for(let w=c;w>=x.weight;w--)d[w]=Math.max(d[w],d[w-x.weight]+x.value);return d[c]}",
    [
      [
        [
          [
            { weight: 2, value: 3 },
            { weight: 3, value: 4 },
            { weight: 4, value: 5 },
          ],
          5,
        ],
        7,
      ],
      [[[{ weight: 2, value: 3 }], 4], 3],
      [[[], 0], 0],
    ],
  ],
  [
    "longest-increasing",
    "fn(numbers): length of longest STRICTLY increasing subsequence, not necessarily contiguous.",
    "xs=>{const d=xs.map(()=>1);for(let i=0;i<xs.length;i++)for(let j=0;j<i;j++)if(xs[j]<xs[i])d[i]=Math.max(d[i],d[j]+1);return Math.max(0,...d)}",
    [
      [[[10, 9, 2, 5, 3, 7, 101, 18]], 4],
      [[[2, 2, 2]], 1],
      [[[]], 0],
    ],
  ],
  [
    "common-subsequence",
    "fn(a,b): length of longest common subsequence of ASCII strings.",
    "(a,b)=>{let d=Array(b.length+1).fill(0);for(const c of a){const n=[0];for(let j=1;j<=b.length;j++)n[j]=c===b[j-1]?d[j-1]+1:Math.max(n[j-1],d[j]);d=n}return d[b.length]}",
    [
      [["abcde", "ace"], 3],
      [["abc", "xyz"], 0],
      [["", "abc"], 0],
    ],
  ],
  [
    "max-subarray",
    "fn(numbers): maximum sum of a nonempty contiguous subarray; null for empty input.",
    "xs=>{if(!xs.length)return null;let best=xs[0],cur=xs[0];for(const x of xs.slice(1)){cur=Math.max(x,cur+x);best=Math.max(best,cur)}return best}",
    [
      [[[-2, 1, -3, 4, -1, 2, 1, -5, 4]], 6],
      [[[-5, -2, -8]], -2],
      [[[]], null],
    ],
  ],
  [
    "unique-substring",
    "fn(ASCIIString): length of longest contiguous substring containing no repeated character.",
    "s=>{let l=0,b=0;const m=new Map();for(let i=0;i<s.length;i++){l=Math.max(l,(m.get(s[i])??-1)+1);m.set(s[i],i);b=Math.max(b,i-l+1)}return b}",
    [
      [["abcabcbb"], 3],
      [["abba"], 2],
      [[""], 0],
    ],
  ],
  [
    "min-window",
    "fn(source,target): shortest contiguous ASCII substring containing target character multiplicities; earliest on equal length; empty string if impossible or target empty.",
    "(s,t)=>{if(!t)return '';const need={};for(const c of t)need[c]=(need[c]||0)+1;let best='';for(let i=0;i<s.length;i++){const have={};for(let j=i;j<s.length;j++){have[s[j]]=(have[s[j]]||0)+1;if(Object.keys(need).every(c=>(have[c]||0)>=need[c])){const x=s.slice(i,j+1);if(!best||x.length<best.length)best=x;break}}}return best}",
    [
      [["ADOBECODEBANC", "ABC"], "BANC"],
      [["aa", "aa"], "aa"],
      [["a", "aa"], ""],
      [["abc", ""], ""],
    ],
  ],
  [
    "wildcard-match",
    "fn(string,pattern): full ASCII match, ? matches one character, * zero or more. Other pattern characters are literal.",
    "(s,p)=>{let d=Array(s.length+1).fill(false);d[0]=true;for(const c of p){const n=Array(s.length+1).fill(false);n[0]=c==='*'&&d[0];for(let j=1;j<=s.length;j++)n[j]=c==='*'?(d[j]||n[j-1]):d[j-1]&&(c==='?'||c===s[j-1]);d=n}return d[s.length]}",
    [
      [["adceb", "*a*b"], true],
      [["acdcb", "a*c?b"], false],
      [["", "*"], true],
      [["", "?"], false],
    ],
  ],
  [
    "interval-subtract",
    "fn([start,end],cuts): half-open intervals; subtract all cuts, return ascending remaining nonempty intervals. Cuts may overlap or extend outside base.",
    "([a,b],cs)=>{let r=a<b?[[a,b]]:[];for(const [l,h] of cs)if(l<h)r=r.flatMap(([x,y])=>h<=x||l>=y?[[x,y]]:[[x,Math.min(y,l)],[Math.max(x,h),y]].filter(([u,v])=>u<v));return r}",
    [
      [
        [
          [0, 10],
          [
            [2, 4],
            [3, 6],
            [9, 12],
          ],
        ],
        [
          [0, 2],
          [6, 9],
        ],
      ],
      [[[0, 3], []], [[0, 3]]],
      [[[1, 1], []], []],
    ],
  ],
  [
    "meeting-rooms",
    "fn(intervals): minimum rooms needed for half-open meetings, ignore zero-length; end at time t frees room before starts at t.",
    "xs=>{const es=xs.filter(([a,b])=>a<b).flatMap(([a,b])=>[[a,1],[b,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let n=0,b=0;for(const [,v] of es){n+=v;b=Math.max(b,n)}return b}",
    [
      [
        [
          [
            [0, 30],
            [5, 10],
            [15, 20],
          ],
        ],
        2,
      ],
      [
        [
          [
            [1, 2],
            [2, 3],
            [2, 2],
          ],
        ],
        1,
      ],
      [[[]], 0],
    ],
  ],
  [
    "tree-preorder",
    "fn(tree): nodes {value,children}, children arrays; preorder values; null returns [].",
    "function visit(t){return t===null?[]:[t.value,...t.children.flatMap(visit)]}",
    [
      [
        [
          {
            value: "a",
            children: [
              { value: "b", children: [] },
              { value: "c", children: [{ value: "d", children: [] }] },
            ],
          },
        ],
        ["a", "b", "c", "d"],
      ],
      [[null], []],
    ],
  ],
  [
    "tree-depth",
    "fn(tree): nodes {children}; maximum node depth, null=0, leaf=1.",
    "function visit(t){return t===null?0:1+Math.max(0,...t.children.map(visit))}",
    [
      [[{ children: [{ children: [] }, { children: [{ children: [] }] }] }], 3],
      [[{ children: [] }], 1],
      [[null], 0],
    ],
  ],
  [
    "flatten-object",
    "fn(object): nested plain objects with primitive or array leaves; flatten keys with dots. Arrays stay leaves; empty objects emit no entry; keys contain no dots.",
    "o=>{const out={};const visit=(x,p)=>{for(const [k,v] of Object.entries(x)){const key=p?p+'.'+k:k;if(v!==null&&typeof v==='object'&&!Array.isArray(v))visit(v,key);else out[key]=v}};visit(o,'');return out}",
    [
      [
        [{ a: { b: 2, c: null }, d: [1, 2], e: {} }],
        { "a.b": 2, "a.c": null, d: [1, 2] },
      ],
      [[{}], {}],
    ],
  ],
  [
    "deep-merge",
    "fn(a,b): recursively merge plain JSON objects; b overrides leaves and arrays (no concatenation). Return new object, preserve both inputs; no prototype-special keys.",
    "(a,b)=>{const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);const merge=(x,y)=>{if(!plain(x)||!plain(y))return structuredClone(y);const r=structuredClone(x);for(const k of Object.keys(y))r[k]=k in x?merge(x[k],y[k]):structuredClone(y[k]);return r};return merge(a,b)}",
    [
      [
        [
          { a: { x: 1 }, b: [1] },
          { a: { y: 2 }, b: [2], c: null },
        ],
        { a: { x: 1, y: 2 }, b: [2], c: null },
      ],
      [[{}, {}], {}],
    ],
  ],
  [
    "json-pointer",
    "fn(document,pointer,fallback): RFC6901 pointer, decode ~1 then ~0; empty pointer returns document, absent OWN path returns fallback; valid syntax only.",
    "(o,p,f)=>{if(!p)return o;for(const k of p.slice(1).split('/').map(k=>k.replace(/~1/g,'/').replace(/~0/g,'~'))){if(o==null||!Object.hasOwn(o,k))return f;o=o[k]}return o}",
    [
      [[{ "a/b": { "~x": [false, null] } }, "/a~1b/~0x/1", "missing"], null],
      [[{}, "/no", 7], 7],
      [[{ a: 1 }, "", 0], { a: 1 }],
    ],
  ],
  [
    "version-compare",
    "fn(a,b): dotted nonnegative integer versions of arbitrary component length; trailing missing components=0; return -1,0,1. No prerelease syntax.",
    "(a,b)=>{a=a.split('.').map(BigInt);b=b.split('.').map(BigInt);for(let i=0;i<Math.max(a.length,b.length);i++){const x=a[i]??0n,y=b[i]??0n;if(x!==y)return x<y?-1:1}return 0}",
    [
      [["1.2", "1.2.0"], 0],
      [["1.10", "1.9"], 1],
      [["9007199254740993", "9007199254740992"], 1],
      [["0", "1"], -1],
    ],
  ],
  [
    "natural-sort",
    "fn(strings): stable case-sensitive ASCII natural ordering, consecutive digits compared numerically (arbitrary length); equal numeric runs tie by remaining text, then original order. No locale rules.",
    "xs=>[...xs].sort((a,b)=>{const x=a.match(/\\d+|\\D+/g)||[],y=b.match(/\\d+|\\D+/g)||[];for(let i=0;i<Math.min(x.length,y.length);i++){let c;if(/^\\d+$/.test(x[i])&&/^\\d+$/.test(y[i])){const u=BigInt(x[i]),v=BigInt(y[i]);c=u<v?-1:u>v?1:0}else c=x[i]<y[i]?-1:x[i]>y[i]?1:0;if(c)return c}return x.length-y.length})",
    [
      [
        [["file10", "file2", "file02", "file1"]],
        ["file1", "file2", "file02", "file10"],
      ],
      [[[]], []],
    ],
  ],
  [
    "money-allocation",
    "fn(total,weights): nonnegative integer cents, nonnegative integer weights with positive sum; proportional integer allocations via largest remainders, equal remainders favor lower index.",
    "(n,ws)=>{const sum=ws.reduce((a,b)=>a+b,0),out=ws.map(w=>Math.floor(n*w/sum)),order=ws.map((w,i)=>({i,r:n*w%sum})).sort((a,b)=>b.r-a.r||a.i-b.i);let left=n-out.reduce((a,b)=>a+b,0);for(let i=0;i<left;i++)out[order[i].i]++;return out}",
    [
      [
        [10, [1, 1, 1]],
        [4, 3, 3],
      ],
      [
        [7, [0, 1, 2]],
        [0, 2, 5],
      ],
      [
        [0, [1, 1]],
        [0, 0],
      ],
    ],
  ],
  [
    "bank-rounding",
    "fn(numerator,denominator): nonnegative safe integers, positive denominator; round rational to nearest integer, EXACT halves to even. Inputs small enough for integer arithmetic.",
    "(n,d)=>{const q=Math.floor(n/d),r=n%d;return 2*r<d?q:2*r>d?q+1:q+(q%2)}",
    [
      [[5, 2], 2],
      [[7, 2], 4],
      [[8, 3], 3],
      [[0, 2], 0],
    ],
  ],
  [
    "lru-simulation",
    "fn(capacity,operations): positive capacity, operations ['put',key,value] or ['get',key]. Return get results (null on miss); both hit/get and put refresh recency; evict least recent.",
    "(c,ops)=>{const m=new Map(),out=[];for(const [op,k,v] of ops){if(op==='get'){if(!m.has(k)){out.push(null);continue}const x=m.get(k);out.push(x);m.delete(k);m.set(k,x)}else{m.delete(k);m.set(k,v);if(m.size>c)m.delete(m.keys().next().value)}}return out}",
    [
      [
        [
          2,
          [
            ["put", "a", 1],
            ["put", "b", 2],
            ["get", "a"],
            ["put", "c", 3],
            ["get", "b"],
            ["get", "c"],
          ],
        ],
        [1, null, 3],
      ],
      [[1, []], []],
    ],
  ],
  [
    "rate-window",
    "fn(timestamps,limit,window): nondecreasing numeric times, positive limit/window; accept if fewer than limit ACCEPTED events in (time-window,time]; return boolean per event. Rejected events do not count.",
    "(ts,n,w)=>{const q=[];return ts.map(t=>{while(q.length&&q[0]<=t-w)q.shift();if(q.length>=n)return false;q.push(t);return true})}",
    [
      [
        [[0, 0, 1, 10, 10, 11], 2, 10],
        [true, true, false, true, true, false],
      ],
      [[[], 1, 5], []],
    ],
  ],
  [
    "token-bucket",
    "fn(capacity,rate,requests): initially full at time 0; requests [time,cost] nondecreasing times, nonnegative costs; refill rate per unit, cap capacity; rejected consumes nothing; return booleans.",
    "(c,r,xs)=>{let t=0,n=c;return xs.map(([now,cost])=>{n=Math.min(c,n+(now-t)*r);t=now;if(cost>n)return false;n-=cost;return true})}",
    [
      [
        [
          3,
          1,
          [
            [0, 2],
            [0, 2],
            [1, 2],
            [2, 2],
            [5, 3],
          ],
        ],
        [true, false, true, false, true],
      ],
      [
        [
          1,
          0,
          [
            [0, 1],
            [9, 1],
          ],
        ],
        [true, false],
      ],
    ],
  ],
  [
    "transaction-ledger",
    "fn(entries): {id,account,amount} integer amounts; first occurrence of each id only, return account balances sorted by account ASCII as [{account,balance}], including zero balances.",
    "xs=>{const seen=new Set(),m=new Map();for(const x of xs)if(!seen.has(x.id)){seen.add(x.id);m.set(x.account,(m.get(x.account)||0)+x.amount)}return [...m].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([account,balance])=>({account,balance}))}",
    [
      [
        [
          [
            { id: "1", account: "b", amount: 5 },
            { id: "1", account: "a", amount: 9 },
            { id: "2", account: "b", amount: -5 },
            { id: "3", account: "a", amount: 2 },
          ],
        ],
        [
          { account: "a", balance: 2 },
          { account: "b", balance: 0 },
        ],
      ],
      [[[]], []],
    ],
  ],
  [
    "grid-path",
    "fn(grid): rectangular 0=open,1=blocked; shortest four-direction edge count top-left to bottom-right; -1 if blocked/unreachable/empty.",
    "g=>{if(!g.length||!g[0].length||g[0][0]||g.at(-1).at(-1))return -1;const h=g.length,w=g[0].length,q=[[0,0,0]],seen=new Set(['0,0']);for(const [x,y,d] of q){if(x===h-1&&y===w-1)return d;for(const [a,b] of [[x+1,y],[x-1,y],[x,y+1],[x,y-1]])if(a>=0&&a<h&&b>=0&&b<w&&!g[a][b]&&!seen.has(a+','+b)){seen.add(a+','+b);q.push([a,b,d+1])}}return -1}",
    [
      [
        [
          [
            [0, 1, 0],
            [0, 0, 0],
            [1, 1, 0],
          ],
        ],
        4,
      ],
      [
        [
          [
            [0, 1],
            [1, 0],
          ],
        ],
        -1,
      ],
      [[[[0]]], 0],
      [[[]], -1],
    ],
  ],
  [
    "island-count",
    "fn(grid): rectangular binary grid; count four-direction connected groups of 1s, no mutation; empty=0.",
    "g=>{const seen=new Set();let n=0;for(let i=0;i<g.length;i++)for(let j=0;j<g[i].length;j++)if(g[i][j]&&!seen.has(i+','+j)){n++;const q=[[i,j]];seen.add(i+','+j);for(const [x,y] of q)for(const [a,b] of [[x+1,y],[x-1,y],[x,y+1],[x,y-1]])if(g[a]?.[b]&&!seen.has(a+','+b)){seen.add(a+','+b);q.push([a,b])}}return n}",
    [
      [
        [
          [
            [1, 0, 1],
            [1, 0, 0],
            [0, 1, 1],
          ],
        ],
        3,
      ],
      [[[[0]]], 0],
      [[[]], 0],
    ],
  ],
  [
    "expression-eval",
    "fn(string): evaluate nonnegative integer literals, spaces, +,-,*,/ with usual precedence; division truncates toward zero; no parentheses, unary signs or zero divisors; intermediate results safe integers.",
    "s=>{const ts=s.match(/\\d+|[+*/-]/g),stack=[];let op='+';for(let i=0;i<ts.length;i+=2){const n=Number(ts[i]);if(op==='+')stack.push(n);else if(op==='-')stack.push(-n);else if(op==='*')stack.push(stack.pop()*n);else stack.push(Math.trunc(stack.pop()/n));op=ts[i+1]}return stack.reduce((a,b)=>a+b,0)}",
    [
      [["3+2*2"], 7],
      [[" 14 - 3 / 2 "], 13],
      [["1-7/2"], -2],
      [["0"], 0],
    ],
  ],
];

export const expertCodingScenarios: CodingScenario[] = scenarios.map(
  ([id, requirement, implementation, cases], i) => ({
    id: `expert-${id}`,
    requirement: `${requirement} Use only built-in Node APIs; no dependencies. Add boundary-case regression tests.`,
    implementation,
    cases,
    create: i < 10,
    addTests: true,
    progressive: i % 3 === 0,
  }),
);
