import statistics as st, itertools
from collections import Counter
from load import nights, STAGES, rows_for
# ---- port of classifier (filterOutliers + phase1 + smoothing + transitions)
# Same inputs as classifySleepStages: outlier-filtered vitals, and movement by
# rounded 5-minute bucket (mov5), not by minute.
def filter_outliers(eps):
    """filterOutliers: hard limits, then null an HR more than 2 std from the
    median of its +-2-row window."""
    out=[]
    for i,e in enumerate(eps):
        hr,hrv,br=e['hr'],e['hrv'],e['br']
        if hr is not None and (hr<45 or hr>130): hr=None
        if hrv is not None and (hrv<1 or hrv>300): hrv=None
        if br is not None and (br<8 or br>25): br=None
        if hr is not None:
            w=[x['hr'] for x in eps[max(0,i-2):i+3] if x['hr'] is not None and 45<=x['hr']<=130]
            if w:
                med=sorted(w)[len(w)//2]; mean=sum(w)/len(w)
                sd=(sum((h-mean)**2 for h in w)/len(w))**0.5
                if sd>0 and abs(hr-med)>2*sd: hr=None
        out.append(dict(e,hr=hr,hrv=hrv,br=br))
    return out
def classify(ep, avg, cq=1.0, deep_r=0.92, rem_r=0.95, rem_hrv=25, rem_mov=30, rem2_mov=50, rem2_hrv=40, wake_mov=200):
    hr,hrv,mov=ep['hr'],ep['hrv'],ep['mov5']
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
    eps=filter_outliers(eps)
    hrs=[e['hr'] for e in eps if e['hr']]; avg=st.mean(hrs) if hrs else 60
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
def grid(groups):
    best=[]
    for dr,rr,rh,rm,wm in itertools.product([0.85,0.88,0.90,0.92,0.94],[0.95,1.0,1.03,1.06],[25,40,60,999],[30,60,120],[100,200,400]):
        tot=ag=0; preds=Counter()
        for eps in groups:
            pr=run(eps,cq=1.0,deep_r=dr,rem_r=rr,rem_hrv=rh,rem_mov=rm,rem2_mov=rm,rem2_hrv=rh,wake_mov=wm)
            for a,e in zip(pr,eps):
                if e['w']: tot+=1; ag+=(a==e['w']); preds[a]+=1
        best.append((ag/tot,dr,rr,rh,rm,wm,dict(preds)))
    best.sort(reverse=True)
    return best
def score(eps, params):
    _,dr,rr,rh,rm,wm,_=params
    pr=run(eps,cq=1.0,deep_r=dr,rem_r=rr,rem_hrv=rh,rem_mov=rm,rem2_mov=rm,rem2_hrv=rh,wake_mov=wm)
    pairs=[(a,e['w']) for a,e in zip(pr,eps) if e['w']]
    return 100*sum(a==b for a,b in pairs)/len(pairs)
print("\n=== grid search pooled over both nights (deep ratio, rem ratio, rem hrv, rem mov, wake mov)")
groups=[rows_for(side,a,b) for (side,a,b) in nights.values()]
best=grid(groups)
for b in best[:8]: print(f"  {b[0]*100:.0f}%  deep<{b[1]} rem>={b[2]} remHRV<{b[3]} remMov<{b[4]} wakeMov>{b[5]} pred={b[6]}")
print("\n=== pooled top-1 params per night (in-sample: both nights picked them)")
for i,eps in enumerate(groups):
    print(f"  night {list(nights)[i]}: {score(eps,best[0]):.0f}%")
print("\n=== leave-one-night-out: params picked on the other night only, scored on the held-out one")
for i,eps in enumerate(groups):
    top=grid([g for j,g in enumerate(groups) if j!=i])[0]
    print(f"  night {list(nights)[i]}: {score(eps,top):.0f}%  deep<{top[1]} rem>={top[2]} remHRV<{top[3]} remMov<{top[4]} wakeMov>{top[5]}")
