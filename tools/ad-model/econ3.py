import math
FX = 1332.0
SPW = 168 * 60 / 25          # sessions per CCU-week
N = 3.8
STD, BR, MAPS = 0.6, 0.4, 7
def P(x): return 1 - (1 - x) ** N
prod = {  # per-match probability x (mode share x map share x p_match)
 'frame':      STD / MAPS * 0.64,
 'mappack':    STD / MAPS * 0.82,
 'owner':      STD / MAPS * 0.77,
 'hoard_std':  STD / MAPS * 0.885,
 'strippack':  BR * 0.76,
 'hoard_strip':BR * 0.29,
 'stripframe': BR * 0.146,
 'city':       STD * 2 / MAPS * 0.82 + BR * 0.76,
 'drop':       BR * 0.60,
 'takeover72': STD / MAPS * 0.93,
}
mult = {'frame':1,'mappack':2,'owner':3.5,'hoard_std':3,'strippack':4,'hoard_strip':3,'city':6,'drop':5,'takeover72':11}
imp = {k: SPW * P(x) * (3/7 if k=='takeover72' else 1) for k, x in prod.items()}  # per billable NG CCU per week
for k,v in imp.items(): print(f"{k:12s} P_sess={P(prod[k]):.4f} imps/bNG-CCU/wk={v:.2f} ratio={v/imp['frame']:.3f}")
idx = 1.5 * imp['frame']   # NGN per billable NG CCU per week
print('index NGN per bNG CCU', idx, 'per web CCU @0.21', idx*0.21, 'per web CCU @0.18', idx*0.18)
print('floor binds below web CCU', 25000/(idx*0.21), 'bNG', 25000/idx)
print('\nEffective viewable CPM (above floor):')
for k,m in mult.items(): print(f"  {k:12s} x{m}: N{1500*m/(imp[k]/imp['frame']):,.0f}")
def F(ccu, b=0.21):
    raw = idx * ccu * b
    return max(25000, round(raw/5000)*5000), raw
print('\nIndex table:')
for c in (500,1000,2500,5000,10000,25000,50000): print(c, F(c, 0.18 if c==500 else 0.21))
cols = [('pilot500',500,0.18),('1k',1000,0.21),('10k',10000,0.21),('50k',50000,0.21)]
print('\nWeekly billable NG imps:')
for k in imp:
    print(f"  {k:12s}", ' | '.join(f"{n}: {imp[k]*c*b:,.0f}" for n,c,b in cols))
print('\nProducts at 1k/10k/50k:')
for k,m in mult.items():
    vals=[F(c)[0]*m for c in (1000,10000,50000)]
    print(f"  {k:12s}", [f"{v:,.0f}" for v in vals], [f"${v/FX:,.0f}" for v in vals[:2]])
# launch inventory weekly units in F: 42 frames + 6 strip packs x4 + 9 hoardings/wrap x3 + drop x5
launch_units = 42 + 6*4 + 9*3 + 5
pilot_units = 12 + 3*4 + 2*3
print('\nlaunch F-units', launch_units, 'pilot', pilot_units)
for n,c,b in cols:
    f = F(c,b)[0]; u = pilot_units if n=='pilot500' else launch_units
    wk = u*f; mo = wk*4.345
    print(f"  {n}: F {f:,} wk N{wk:,.0f} mo N{mo:,.0f} ${mo/FX:,.0f}")
# daily billable NG impressions across units
def day(units):
    return sum(units[k]*imp[k] for k in units)/7
launch = {'frame':42,'strippack':6,'hoard_std':5,'hoard_strip':4,'drop':1}
pilot = {'frame':12,'strippack':3,'hoard_std':2}
for n,c,b in cols:
    u = pilot if n=='pilot500' else launch
    print(f"  {n}: NG billable imps/day {day(u)*c*b:,.0f}")
# 500 table per frame
fr1k = imp['frame']*1000*0.21; so1k = imp['owner']*1000*0.21
print('\nframe imps per 1k web CCU/wk', fr1k, 'owner', so1k)
readings = [('N500/wk',500),('N500/mo',500/4.345),('N500k/wk',500e3),('N500k/mo',500e3/4.345),('$500/wk',500*FX),('$500/mo',500*FX/4.345)]
for lab,wk in readings:
    cpm=[wk/(fr1k*m)*1000 for m in (1,10,50)]
    fair_frame = wk/(1.5*fr1k)*1000
    fair_screen_rc = wk/(3.5*1.5*fr1k)*1000
    fair_screen_cpm = wk/(1.5*so1k)*1000
    print(f"{lab:9s} CPM N{cpm[0]:,.2f} N{cpm[1]:,.2f} N{cpm[2]:,.2f} | ${cpm[0]/FX:.2f} ${cpm[1]/FX:.2f} ${cpm[2]/FX:.2f} | fair frame {fair_frame:,.1f} | screen@3.5x {fair_screen_rc:,.1f} | screen@N1500 {fair_screen_cpm:,.1f}")
print('ratios', 330/(500/fr1k*1000), 2000/(500/fr1k*1000), 330/(500/4.345/(fr1k*50)*1000), 2000/(500/4.345/(fr1k*50)*1000))
# pilot CPM at floor
for share in (0.3,0.2,0.1):
    i = imp['frame']*500*share*0.6
    print('pilot NG share',share,'frame imps/wk',round(i),'CPM at floor',round(25000/i*1000),'$',round(25000/i*1000/FX,2))
# Lagos Life vs us
so10 = F(10000)[0]*3.5
print('\nScreen Owner 10k', so10, 'per NG avg', so10/3000, 'per bNG', so10/2100, 'per NG peak', so10/4500, so10/6000)
print('LL avg board', 6*250e3, 'per peak', 6*250e3/110e3, 43*250e3/110e3)
# programmatic
units_imps = sum(launch[k]*imp[k] for k in launch)  # per billable CCU per week
mo = units_imps*4.345
for c in (10000,50000):
    IN = c*0.45*0.71; OT = c*0.25*0.71
    plan = (IN*mo*0.10*0.40 + OT*mo*0.30*1.0)/1000*0.5
    cons = (IN*mo*0.05*0.30 + OT*mo*0.15*0.50)/1000*0.4
    print('prog',c,'IN imps/mo',IN*mo/1e6,'M other',OT*mo/1e6,'M plan $',round(plan),'cons $',round(cons))
# share of screen
def share(A,z,m):
    return A/((36*m)*(20.25*m)*((32.1*m+abs(z))/(32.1*m))**2)
ms=[1.0,1.2,1.4,1.6,1.8,2.0,2.3]
for name,A,z in [('Screen',48,6),('Hoarding',54,6),('Airship 21x3.5@-8',73.5,8),('LM-H1 21x3.5@-8',73.5,8),('Wrap 20x3.3@-9',66,9)]:
    print(name, [f"{100*share(A,z,m):.1f}" for m in ms])
# memory
for name,w,h in [('screen',512,384),('6:1',1152,192)]:
    px = w*h*4/3
    print(name, 'KB @4bpp', px*0.5/1024, '@8bpp', px/1024)
print('pool MB', (32*512*384*4/3*0.5 + 8*1152*192*4/3*0.5)/2**20)
# mask quantisation
for W,H in ((160,90),(320,180)):
    A = W*H*0.015
    for r in (4/3,6):
        h = math.sqrt(A/r); w = r*h
        print(W,H,'ratio',r,'px',A,'err',(w+h)/(w*h))
# holdout power
z=1.96+0.8416
for k,name in ((4,'20%'),(19,'5%')):
    p=0.08
    nh = z*z*p*(1-p)*(1+1/k)/0.01**2
    print(name,'holdout n',round(nh),'total',round(nh*(k+1)))
