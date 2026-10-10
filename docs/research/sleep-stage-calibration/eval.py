import sqlite3, csv, statistics as st, itertools
from datetime import datetime, timedelta, timezone
from collections import defaultdict, Counter
LA=timezone(timedelta(hours=-7))
c=sqlite3.connect('poddb/biometrics.db')
def p(s): return datetime.strptime(s, '%Y-%m-%d %H:%M:%S %z')
rows=[r for r in csv.DictReader(open('records.csv'))]
M={'AsleepCore':'light','AsleepDeep':'deep','AsleepREM':'rem','Awake':'wake'}
wl={}
for r in rows:
    if 'Watch' in r['source'] and r['type']=='SleepAnalysis':
        v=M.get(r['value'].replace('HKCategoryValueSleepAnalysis',''))
        if not v: continue
        t=p(r['start']).replace(second=0); e=p(r['end'])
        while t<e: wl[int(t.timestamp())//60]=v; t+=timedelta(minutes=1)
nights={'10-08':('left',datetime(2026,10,9,2,0,tzinfo=LA),datetime(2026,10,9,8,20,tzinfo=LA)),
        '10-09':('left',datetime(2026,10,10,3,10,tzinfo=LA),datetime(2026,10,10,11,5,tzinfo=LA))}
STAGES=('wake','light','deep','rem')
def rows_for(side,a,b):
    v=c.execute("select timestamp,heart_rate,hrv,breathing_rate from vitals where side=? and timestamp between ? and ? order by timestamp",(side,a.timestamp(),b.timestamp())).fetchall()
    m={int(t)//60:mv for t,mv in c.execute("select timestamp,total_movement from movement where side=? and timestamp between ? and ?",(side,a.timestamp(),b.timestamp()))}
    out=[]
    for t,hr,hrv,br in v:
        k=int(t)//60
        out.append(dict(t=t,k=k,hr=hr,hrv=hrv,br=br,mov=m.get(k),w=wl.get(k)))
    return out
# ---- port of classifier (phase1 + smoothing + transitions)
def classify(ep, avg, cq=1.0, deep_r=0.92, rem_r=0.95, rem_hrv=25, rem_mov=30, rem2_mov=50, rem2_hrv=40, wake_mov=200):
    hr,hrv,mov=ep['hr'],ep['hrv'],ep['mov']
    if hr is not None and (hr<45 or hr>130): hr=None
    if hrv is not None and (hrv<1 or hrv>300): hrv=None
    if cq<0.3: return 'wake' if (mov is not None and mov>wake_mov) else 'light'
    if mov is not None and mov>wake_mov: return 'wake'
    if hr:
        r=hr/avg
        if r<deep_r: return 'deep'
        if r>=rem_r:
            if hrv is not None and hrv<rem_hrv and mov is not None and mov<rem_mov: return 'rem'
            if mov is not None and mov<rem2_mov and hrv is not None and hrv<rem2_hrv: return 'rem'
            if mov is not None and mov>100: return 'wake'
    return 'light'
def post(st_):
    s=list(st_)
    for i in range(1,len(s)-1):
        if s[i-1]==s[i+1] and s[i]!=s[i-1]: s[i]=s[i-1]
    for i in range(1,len(s)):
        a,b=s[i-1],s[i]
        if (a,b) in {('wake','deep'),('deep','wake'),('deep','rem'),('rem','deep')}: s[i]='light'
    return s
def run(eps, **kw):
    hrs=[e['hr'] for e in eps if e['hr']]; avg=st.mean(hrs)
    return post([classify(e,avg,**kw) for e in eps])
def report(name, pred, eps):
    pairs=[(a,e['w']) for a,e in zip(pred,eps) if e['w']]
    conf=Counter(pairs); n=len(pairs); agree=sum(v for (a,b),v in conf.items() if a==b)
    print(f"  {name:28} n={n:3} agree={100*agree/n:4.0f}%  pred={dict(Counter(a for a,_ in pairs))}")
    return conf
alln=[]
for k,(side,a,b) in nights.items():
    eps=rows_for(side,a,b); alln+=eps
    lab=[e for e in eps if e['w']]
    print(f"\n=== night {k} {side}: pod epochs={len(eps)} with watch label={len(lab)}  watch dist={dict(Counter(e['w'] for e in lab))}")
    hrs=[e['hr'] for e in eps if e['hr']]; avg=st.mean(hrs)
    print(f"  avgHR={avg:.1f}")
    print("  feature medians per WATCH stage (hr ratio / hrv / movement / breathing):")
    for s in STAGES:
        g=[e for e in lab if e['w']==s]
        if not g: continue
        f=lambda key: [e[key] for e in g if e[key] is not None]
        med=lambda xs: f"{st.median(xs):6.2f}" if xs else "   n/a"
        q=lambda xs: (f"[{sorted(xs)[len(xs)//4]:.0f}-{sorted(xs)[3*len(xs)//4]:.0f}]" if xs else "")
        print(f"    {s:5} n={len(g):3} hrR={med([e['hr']/avg for e in g if e['hr']])} hrv={med(f('hrv'))}{q(f('hrv')):>10} mov={med(f('mov'))}{q(f('mov')):>10} br={med(f('br'))}")
    print("  classifier variants (agreement with Watch over labeled minutes):")
    conf=report("as-deployed (cq=0)", run(eps,cq=0.0), eps)
    conf=report("iOS rules (cq=1)", run(eps,cq=1.0), eps)
    for s in STAGES: print(f"      {s:5} ->", {b:conf[(s,b)] for b in STAGES if conf[(s,b)]})
    maj=Counter(e['w'] for e in lab).most_common(1)[0][0]
    report(f"always-{maj}", [maj]*len(eps), eps)
# grid search across both nights (pooled)
print("\n=== grid search pooled over both nights (deep ratio, rem ratio, rem hrv, rem mov, wake mov)")
best=[]
groups=[rows_for(side,a,b) for (side,a,b) in nights.values()]
for dr,rr,rh,rm,wm in itertools.product([0.85,0.88,0.90,0.92,0.94],[0.95,1.0,1.03,1.06],[25,40,60,999],[30,60,120],[100,200,400]):
    tot=ag=0; preds=Counter()
    for eps in groups:
        pr=run(eps,cq=1.0,deep_r=dr,rem_r=rr,rem_hrv=rh,rem_mov=rm,rem2_mov=rm,rem2_hrv=rh,wake_mov=wm)
        for a,e in zip(pr,eps):
            if e['w']: tot+=1; ag+=(a==e['w']); preds[a]+=1
    best.append((ag/tot,dr,rr,rh,rm,wm,dict(preds)))
best.sort(reverse=True)
for b in best[:8]: print(f"  {b[0]*100:.0f}%  deep<{b[1]} rem>={b[2]} remHRV<{b[3]} remMov<{b[4]} wakeMov>{b[5]} pred={b[6]}")
# leave-one-night-out for the top config
print("\n=== leave-one-night-out check for top-1 params")
_,dr,rr,rh,rm,wm,_=best[0]
for i,eps in enumerate(groups):
    pr=run(eps,cq=1.0,deep_r=dr,rem_r=rr,rem_hrv=rh,rem_mov=rm,rem2_mov=rm,rem2_hrv=rh,wake_mov=wm)
    pairs=[(a,e['w']) for a,e in zip(pr,eps) if e['w']]
    print(f"  night {list(nights)[i]}: {100*sum(a==b for a,b in pairs)/len(pairs):.0f}%")
