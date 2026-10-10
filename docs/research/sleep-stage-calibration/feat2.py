import sqlite3, csv, statistics as st
from datetime import datetime, timedelta, timezone
from collections import Counter
exec(open('eval.py').read().split('# ---- port of classifier')[0])  # reuse loaders: nights, rows_for, wl
import numpy as np
print("\n=== movement health per night (nonzero fraction, p50/p90/p99)")
for k,(side,a,b) in nights.items():
    eps=rows_for(side,a,b); mv=[e['mov'] for e in eps if e['mov'] is not None]
    print(f"  {k}: n={len(mv)} nonzero={sum(1 for x in mv if x>0)/len(mv):.0%} p50={np.percentile(mv,50):.0f} p90={np.percentile(mv,90):.0f} p99={np.percentile(mv,99):.0f}")
print("\n=== whole pod session vs Watch-covered window (night 10-09, sleep_record 1097 is 02:04->18:04)")
sid=c.execute("select entered_bed_at,left_bed_at from sleep_records where id=1097").fetchone()
for label,(a,b) in {'full 16h record':sid,'watch window':(nights['10-09'][1].timestamp(),nights['10-09'][2].timestamp())}.items():
    r=c.execute("select count(*),avg(heart_rate),avg(hrv),avg(breathing_rate) from vitals where side='left' and timestamp between ? and ?",(a,b)).fetchone()
    print(f"  {label:16} n={r[0]} HR={r[1]:.1f} HRV={r[2]:.1f} BR={r[3]:.1f}")
# vitals after the watch window ended (bed presumably empty)
r=c.execute("select count(*),avg(heart_rate),avg(hrv),avg(breathing_rate) from vitals where side='left' and timestamp between ? and ?",(nights['10-09'][2].timestamp(),sid[1])).fetchone()
print(f"  after 11:05 ->18:04  n={r[0]} HR={r[1]} HRV={r[2]} BR={r[3]}  (bed likely empty; vitals still emitted?)")
print("\n=== windowed features per Watch stage (15-min centered): HR std, HRV/night-median, BR std, time-since-onset")
def windowed(eps):
    hr=np.array([e['hr'] if e['hr'] else np.nan for e in eps],float)
    hrv=np.array([e['hrv'] if e['hrv'] else np.nan for e in eps],float)
    br=np.array([e['br'] if e['br'] else np.nan for e in eps],float)
    medhrv=np.nanmedian(hrv); medhr=np.nanmedian(hr)
    out=[]
    for i,e in enumerate(eps):
        s=slice(max(0,i-7),i+8)
        out.append(dict(w=e['w'],hr_std=np.nanstd(hr[s]),hr_rel=np.nanmean(hr[s])/medhr,hrv_rel=np.nanmean(hrv[s])/medhrv,br_std=np.nanstd(br[s]),tso=i/len(eps)))
    return out
allf=[]
for k,(side,a,b) in nights.items():
    f=[x for x in windowed(rows_for(side,a,b)) if x['w']]; allf+=f
    print(f"  night {k}")
    for s in STAGES:
        g=[x for x in f if x['w']==s]
        if not g: continue
        m=lambda key: np.nanmedian([x[key] for x in g])
        print(f"    {s:5} n={len(g):3} hr_std={m('hr_std'):.2f} hr_rel={m('hr_rel'):.3f} hrv_rel={m('hrv_rel'):.2f} br_std={m('br_std'):.2f} tso={m('tso'):.2f}")
try:
    from sklearn.tree import DecisionTreeClassifier
    from sklearn.ensemble import RandomForestClassifier
    keys=['hr_std','hr_rel','hrv_rel','br_std','tso']
    groups=[[x for x in windowed(rows_for(side,a,b)) if x['w']] for (side,a,b) in nights.values()]
    print("\n=== leave-one-night-out, windowed features, small tree / forest (4-class and sleep-vs-wake+deep/light/rem)")
    for i in range(2):
        tr=[x for j,g in enumerate(groups) if j!=i for x in g]; te=groups[i]
        X=lambda g: np.nan_to_num(np.array([[x[k] for k in keys] for x in g]))
        y=lambda g: [x['w'] for x in g]
        for name,clf in (('tree d3',DecisionTreeClassifier(max_depth=3,class_weight='balanced',random_state=0)),('forest',RandomForestClassifier(200,max_depth=4,class_weight='balanced',random_state=0))):
            clf.fit(X(tr),y(tr)); pr=clf.predict(X(te))
            acc=np.mean(pr==np.array(y(te)))
            print(f"  test night {list(nights)[i]} {name:8} acc={acc:.0%} pred={dict(Counter(pr))} truth={dict(Counter(y(te)))}")
except ImportError as e: print("no sklearn",e)
