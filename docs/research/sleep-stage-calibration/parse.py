import re, sys, csv
src = '/Users/ng/Desktop/apple_health_export/export.xml'
pat = re.compile(r'<Record type="(HKCategoryTypeIdentifierSleepAnalysis|HKQuantityTypeIdentifierHeartRate|HKQuantityTypeIdentifierHeartRateVariabilitySDNN|HKQuantityTypeIdentifierRespiratoryRate)"([^>]*)/?>')
attr = re.compile(r'(\w+)="([^"]*)"')
out = csv.writer(open('records.csv','w'))
out.writerow(['type','source','sourceVersion','start','end','value','unit','device'])
with open(src, encoding='utf-8', errors='replace') as f:
    for line in f:
        m = pat.search(line)
        if not m: continue
        a = dict(attr.findall(m.group(2)))
        out.writerow([m.group(1).replace('HKCategoryTypeIdentifier','').replace('HKQuantityTypeIdentifier',''),
                      a.get('sourceName',''), a.get('sourceVersion',''), a.get('startDate',''), a.get('endDate',''),
                      a.get('value',''), a.get('unit',''), a.get('device','')[:80]])
