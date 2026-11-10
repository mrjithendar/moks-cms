import json,glob,sys,statistics,os
d=sys.argv[1]
pages={}
for f in sorted(glob.glob(d+'/*.json')):
    name=os.path.basename(f).rsplit('-',1)[0]
    j=json.load(open(f)); a=j['audits']; c=j['categories']
    pages.setdefault(name,[]).append(dict(perf=c['performance']['score']*100,a11y=c['accessibility']['score']*100,seo=c['seo']['score']*100,lcp=a['largest-contentful-paint']['numericValue'],cls=a['cumulative-layout-shift']['numericValue'],tbt=a['total-blocking-time']['numericValue'],js=sum(i.get('transferSize',0) for i in a['network-requests']['details']['items'] if i.get('resourceType')=='Script')))
print(f"{'page':18} {'perf':>5} {'a11y':>5} {'seo':>4} {'LCP ms':>7} {'CLS':>6} {'TBT ms':>7} {'JS KB':>6}")
for k,v in pages.items():
    m=lambda key: statistics.median(x[key] for x in v)
    print(f"{k:18} {m('perf'):5.0f} {m('a11y'):5.0f} {m('seo'):4.0f} {m('lcp'):7.0f} {m('cls'):6.3f} {m('tbt'):7.0f} {m('js')/1024:6.0f}  (n={len(v)})")
