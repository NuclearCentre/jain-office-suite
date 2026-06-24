/* ipcRenderer removed — using window.electronAPI via preload.js */

const COLS = 52, ROWS = 500, INITIAL_ROWS = 500;

// ── Multi-Sheet State ─────────────────────────────────────────────────────────
let sheets = [{
  name: 'Sheet1',
  data: {}, cellFmt: {}, cellStyle: {}, cellComments: {}, lockedCells: new Set(),
  namedRanges: {}, colWidths: {}, rowHeights: {}
}];
let activeSheet = 0;

// Active sheet proxies
let data, cellFmt, cellStyle, cellComments, namedRanges, lockedCells, colWidths, rowHeights;
function bindSheet() {
  data = sheets[activeSheet].data;
  cellFmt = sheets[activeSheet].cellFmt;
  cellStyle = sheets[activeSheet].cellStyle;
  cellComments = sheets[activeSheet].cellComments;
  namedRanges = sheets[activeSheet].namedRanges;
  lockedCells = sheets[activeSheet].lockedCells;
  colWidths = sheets[activeSheet].colWidths;
  rowHeights = sheets[activeSheet].rowHeights;
}
bindSheet();

const dataValidation = {};
let selR=0,selC=0,rangeStart=null,rangeEnd=null;
let clipboard=null,gridlines=true,zoom=100,sheetProtected=false;
let currentFilePath=null,unsaved=false,autoCalc=true,filterActive=false;
let undoStack=[],redoStack=[],macros={},pageOrientation='portrait',pageSize='A4';
let frozenRows=0,frozenCols=0,showHeaders=true,showRuler=false,editMode=false;
let _activeInp=null,_activeR=-1,_activeC=-1;
let findResults=[],findIdx=0;
let darkMode=false;
// Formula-mode range selection (separate from normal rangeStart/rangeEnd)
let _formulaSel=null, _formulaSelEnd=null;

function colName(c){if(c<26)return String.fromCharCode(65+c);return String.fromCharCode(65+Math.floor(c/26)-1)+String.fromCharCode(65+(c%26));}
const cellId=(r,c)=>colName(c)+(r+1);
function parseRef(ref){var clean=ref.replace(/$/g,'');var m=clean.match(/^([A-Z]{1,2})(\d+)$/);if(!m)return null;var col=m[1];var c=col.length===1?col.charCodeAt(0)-65:(col.charCodeAt(0)-64)*26+(col.charCodeAt(1)-65);return{r:parseInt(m[2])-1,c:c};}
const getRaw=(r,c)=>data[cellId(r,c)]||'';
function setRaw(r,c,v,skipUndo){
  if(sheetProtected&&lockedCells.has(cellId(r,c))){alert('Cell '+cellId(r,c)+' is locked.');return;}
  if(!skipUndo){undoStack.push({id:cellId(r,c),prev:getRaw(r,c)});redoStack=[];}
  if(v==='')delete data[cellId(r,c)];else data[cellId(r,c)]=v;
  renderCell(r,c);
  // Recalculate all formula cells that may depend on this cell
  recalcDependents();
  markUnsaved();
}

// Re-renders all formula cells in the sheet after any value change
function recalcDependents(){
  for(var key in data){
    var v=data[key];
    if(v&&v.startsWith('=')){
      var p=parseRef(key);
      if(p) renderCell(p.r,p.c);
    }
  }
}

// ── Formula Engine ────────────────────────────────────────────────────────────
function evalFormula(formula,depth){
  depth=depth||0;if(depth>10)return'#CIRC';
  try{
    let expr=formula.replace(/^=/,'');
    // Named ranges
    for(var nm in namedRanges){expr=expr.replace(new RegExp('\\b'+nm+'\\b','g'),namedRanges[nm]);}
    expr=expr.replace(/([A-Z]+\d+):([A-Z]+\d+)/g,function(m,a,b){
      var s=parseRef(a),e=parseRef(b);if(!s||!e)return'0';
      var vals=[];
      for(var r=s.r;r<=e.r;r++)for(var c=s.c;c<=e.c;c++){
        var v=getRaw(r,c);
        if(v&&v.startsWith('='))v=String(evalFormula(v,depth+1));
        var n=parseFloat(v);
        vals.push(isNaN(n)?0:n);
      }
      return vals.length?vals.join(','):'0';
    });
    expr=expr.replace(/\b([A-Z]+\d+)\b/g,function(m,ref){
      var p=parseRef(ref);if(!p)return'0';
      var v=getRaw(p.r,p.c);
      if(v&&v.startsWith('='))return evalFormula(v,depth+1);
      return isNaN(parseFloat(v))?'"'+v+'"':(v||'0');
    });
    expr=expr
      .replace(/\bSUM\(/g,'__sum(').replace(/\bAVERAGE\(/g,'__avg(')
      .replace(/\bCOUNT\(/g,'__count(').replace(/\bCOUNTA\(/g,'__counta(')
      .replace(/\bMAX\(/g,'__max(').replace(/\bMIN\(/g,'__min(')
      .replace(/\bIF\(/g,'__if(').replace(/\bIFS\(/g,'__ifs(')
      .replace(/\bCONCAT\(/g,'__concat(').replace(/\bCONCATENATE\(/g,'__concat(')
      .replace(/\bLEN\(/g,'__len(').replace(/\bROUND\(/g,'__round(')
      .replace(/\bROUNDUP\(/g,'__roundup(').replace(/\bROUNDDOWN\(/g,'__rounddown(')
      .replace(/\bABS\(/g,'Math.abs(').replace(/\bSQRT\(/g,'Math.sqrt(')
      .replace(/\bPOWER\(/g,'Math.pow(').replace(/\bMOD\(/g,'__mod(')
      .replace(/\bUPPER\(/g,'__upper(').replace(/\bLOWER\(/g,'__lower(')
      .replace(/\bTRIM\(/g,'__trim(').replace(/\bLEFT\(/g,'__left(')
      .replace(/\bRIGHT\(/g,'__right(').replace(/\bMID\(/g,'__mid(')
      .replace(/\bFIND\(/g,'__find(').replace(/\bSUBSTITUTE\(/g,'__substitute(')
      .replace(/\bTODAY\(\)/g,'__today()').replace(/\bNOW\(\)/g,'__now()')
      .replace(/\bVLOOKUP\(/g,'__vlookup(').replace(/\bHLOOKUP\(/g,'__hlookup(')
      .replace(/\bINDEX\(/g,'__index(').replace(/\bMATCH\(/g,'__match(')
      .replace(/\bIFERROR\(/g,'__iferror(').replace(/\bISBLANK\(/g,'__isblank(')
      .replace(/\bISNUMBER\(/g,'__isnumber(').replace(/\bISTEXT\(/g,'__istext(')
      .replace(/\bCOUNTIF\(/g,'__countif(').replace(/\bSUMIF\(/g,'__sumif(').replace(/\bPMT\(/g,'__pmt(')
      .replace(/\bNPV\(/g,'__npv(').replace(/\bINT\(/g,'Math.floor(')
      .replace(/\bNOT\(/g,'__not(').replace(/\bAND\(/g,'__and(').replace(/\bOR\(/g,'__or(')
      .replace(/\bCEILING\(/g,'Math.ceil(').replace(/\bFLOOR\(/g,'Math.floor(')
      .replace(/\bLOG\(/g,'Math.log10(').replace(/\bLN\(/g,'Math.log(')
      .replace(/\bPI\(\)/g,'Math.PI').replace(/\bRAND\(\)/g,'Math.random()')
      .replace(/\bDATE\(/g,'__date(').replace(/\bYEAR\(/g,'__year(')
      .replace(/\bMONTH\(/g,'__month(').replace(/\bDAY\(/g,'__day(')
      .replace(/\bEDATE\(/g,'__edate(').replace(/\bNETWORKDAYS\(/g,'__networkdays(')
      .replace(/\bTEXT\(/g,'__text(').replace(/\bVALUE\(/g,'parseFloat(')
      .replace(/\bCHAR\(/g,'__char(').replace(/\bCODE\(/g,'__code(')
      .replace(/\bREPT\(/g,'__rept(').replace(/\bPROPER\(/g,'__proper(')
      .replace(/\bEXACT\(/g,'__exact(').replace(/\bSUMPRODUCT\(/g,'__sumproduct(')
      .replace(/\bAVERAGEIF\(/g,'__averageif(').replace(/\bCOUNTIFS\(/g,'__countifs(')
      // ── Statistical ──────────────────────────────────────────────────────
      .replace(/\bMEDIAN\(/g,'__median(')
      .replace(/\bMODE\.MULT\(/g,'__mode(').replace(/\bMODE\(/g,'__mode(')
      .replace(/\bSTDEV\.P\(/g,'__stdevp(').replace(/\bSTDEV\.S\(/g,'__stdev(')
      .replace(/\bSTDEVPA\(/g,'__stdevp(').replace(/\bSTDEVP\(/g,'__stdevp(')
      .replace(/\bSTDEVA\(/g,'__stdev(').replace(/\bSTDEV\(/g,'__stdev(')
      .replace(/\bVAR\.P\(/g,'__varp(').replace(/\bVAR\.S\(/g,'__var(')
      .replace(/\bVARPA\(/g,'__varp(').replace(/\bVARP\(/g,'__varp(')
      .replace(/\bVARA\(/g,'__var(').replace(/\bVAR\(/g,'__var(')
      .replace(/\bLARGE\(/g,'__large(').replace(/\bSMALL\(/g,'__small(')
      .replace(/\bRANK\.AVG\(/g,'__rankavg(').replace(/\bRANK\.EQ\(/g,'__rank(').replace(/\bRANK\(/g,'__rank(')
      .replace(/\bQUARTILE\.INC\(/g,'__quartile(').replace(/\bQUARTILE\.EXC\(/g,'__quartileexc(').replace(/\bQUARTILE\(/g,'__quartile(')
      .replace(/\bPERCENTILE\.INC\(/g,'__percentile(').replace(/\bPERCENTILE\.EXC\(/g,'__percentileexc(').replace(/\bPERCENTILE\(/g,'__percentile(')
      .replace(/\bPERCENTRANK\.INC\(/g,'__percentrank(').replace(/\bPERCENTRANK\.EXC\(/g,'__percentrank(').replace(/\bPERCENTRANK\(/g,'__percentrank(')
      .replace(/\bCORREL\(/g,'__correl(').replace(/\bPEARSON\(/g,'__correl(')
      .replace(/\bCOVARIANCE\.P\(/g,'__covarp(').replace(/\bCOVARIANCE\.S\(/g,'__covar(').replace(/\bCOVAR\(/g,'__covar(')
      .replace(/\bSLOPE\(/g,'__slope(').replace(/\bINTERCEPT\(/g,'__intercept(')
      .replace(/\bFORECAST\(/g,'__forecast(').replace(/\bGROWTH\(/g,'__growth(').replace(/\bTREND\(/g,'__trend(')
      .replace(/\bLINEST\(/g,'__linest(').replace(/\bLOGEST\(/g,'__logest(')
      .replace(/\bRSQ\(/g,'__rsq(').replace(/\bSTEYX\(/g,'__steyx(')
      .replace(/\bKURT\(/g,'__kurt(').replace(/\bSKEW\(/g,'__skew(')
      .replace(/\bGEOMEAN\(/g,'__geomean(').replace(/\bHARMEAN\(/g,'__harmean(')
      .replace(/\bTRIMMEAN\(/g,'__trimmean(').replace(/\bDEVSQ\(/g,'__devsq(')
      .replace(/\bAVEDEV\(/g,'__avedev(').replace(/\bSTANDARDIZE\(/g,'__standardize(')
      .replace(/\bNORM\.S\.DIST\(/g,'__normsdist(').replace(/\bNORMSDIST\(/g,'__normsdist(')
      .replace(/\bNORM\.S\.INV\(/g,'__normsinv(').replace(/\bNORMSINV\(/g,'__normsinv(')
      .replace(/\bNORM\.DIST\(/g,'__normdist(').replace(/\bNORMDIST\(/g,'__normdist(')
      .replace(/\bNORM\.INV\(/g,'__norminv(').replace(/\bNORMINV\(/g,'__norminv(')
      .replace(/\bT\.DIST\.2T\(/g,'__tdist(').replace(/\bT\.DIST\.RT\(/g,'__tdist(').replace(/\bT\.DIST\(/g,'__tdist(').replace(/\bTDIST\(/g,'__tdist(')
      .replace(/\bT\.INV\.2T\(/g,'__tinv(').replace(/\bT\.INV\(/g,'__tinv(').replace(/\bTINV\(/g,'__tinv(')
      .replace(/\bT\.TEST\(/g,'__ttest(').replace(/\bTTEST\(/g,'__ttest(')
      .replace(/\bCHISQ\.DIST\.RT\(/g,'__chidist(').replace(/\bCHISQ\.DIST\(/g,'__chidist(').replace(/\bCHIDIST\(/g,'__chidist(')
      .replace(/\bCHISQ\.INV\.RT\(/g,'__chiinv(').replace(/\bCHISQ\.INV\(/g,'__chiinv(').replace(/\bCHIINV\(/g,'__chiinv(')
      .replace(/\bCHISQ\.TEST\(/g,'__chitest(').replace(/\bCHITEST\(/g,'__chitest(')
      .replace(/\bF\.DIST\.RT\(/g,'__fdist(').replace(/\bF\.DIST\(/g,'__fdist(').replace(/\bFDIST\(/g,'__fdist(')
      .replace(/\bF\.INV\.RT\(/g,'__finv(').replace(/\bF\.INV\(/g,'__finv(').replace(/\bFINV\(/g,'__finv(')
      .replace(/\bF\.TEST\(/g,'__ftest(').replace(/\bFTEST\(/g,'__ftest(')
      .replace(/\bBETA\.DIST\(/g,'__betadist(').replace(/\bBETADIST\(/g,'__betadist(')
      .replace(/\bBETA\.INV\(/g,'__betainv(').replace(/\bBETAINV\(/g,'__betainv(')
      .replace(/\bBINOM\.DIST\.RANGE\(/g,'__binomrange(')
      .replace(/\bBINOM\.DIST\(/g,'__binomdist(').replace(/\bBINOMDIST\(/g,'__binomdist(')
      .replace(/\bBINOM\.INV\(/g,'__binoминv(').replace(/\bCRITBINOM\(/g,'__binoминv(')
      .replace(/\bNEGBINOM\.DIST\(/g,'__negbinomdist(').replace(/\bNEGBINOMDIST\(/g,'__negbinomdist(')
      .replace(/\bEXPON\.DIST\(/g,'__expondist(').replace(/\bEXPONDIST\(/g,'__expondist(')
      .replace(/\bGAMMA\.DIST\(/g,'__gammadist(').replace(/\bGAMMADIST\(/g,'__gammadist(')
      .replace(/\bGAMMA\.INV\(/g,'__gammainv(').replace(/\bGAMMAINV\(/g,'__gammainv(')
      .replace(/\bGAMMALN\.PRECISE\(/g,'__gammaln(').replace(/\bGAMMALN\(/g,'__gammaln(')
      .replace(/\bHYPGEOM\.DIST\(/g,'__hypgeomdist(').replace(/\bHYPGEOMDIST\(/g,'__hypgeomdist(')
      .replace(/\bLOGNORM\.DIST\(/g,'__lognormdist(').replace(/\bLOGNORMDIST\(/g,'__lognormdist(')
      .replace(/\bLOGNORM\.INV\(/g,'__loginv(').replace(/\bLOGINV\(/g,'__loginv(')
      .replace(/\bPOISSON\.DIST\(/g,'__poisson(').replace(/\bPOISSON\(/g,'__poisson(')
      .replace(/\bWEIBULL\.DIST\(/g,'__weibull(').replace(/\bWEIBULL\(/g,'__weibull(')
      .replace(/\bPROB\(/g,'__prob(').replace(/\bFREQUENCY\(/g,'__frequency(')
      .replace(/\bPERMUT\(/g,'__permut(').replace(/\bCOMBIN\(/g,'__combin(')
      .replace(/\bCOUNTBLANK\(/g,'__countblank(')
      .replace(/\bMAXA\(/g,'__maxa(').replace(/\bMINA\(/g,'__mina(')
      .replace(/\bFISHER\(/g,'__fisher(').replace(/\bFISHERINV\(/g,'__fisherinv(')
      .replace(/\bCONFIDENCE\.T\(/g,'__confidence(').replace(/\bCONFIDENCE\.NORM\(/g,'__confidence(').replace(/\bCONFIDENCE\(/g,'__confidence(')
      // ── Financial (new) ──────────────────────────────────────────────────
      .replace(/\bFV\(/g,'__fv(').replace(/\bPV\(/g,'__pv(')
      .replace(/\bRATE\(/g,'__rate(').replace(/\bNPER\(/g,'__nper(')
      .replace(/\bIPMT\(/g,'__ipmt(').replace(/\bPPMT\(/g,'__ppmt(')
      .replace(/\bSLN\(/g,'__sln(').replace(/\bDB\(/g,'__db(')
      .replace(/\bIRR\(/g,'__irr(').replace(/\bMIRR\(/g,'__mirr(')
      .replace(/\bXNPV\(/g,'__xnpv(').replace(/\bXIRR\(/g,'__xirr(')
      // ── Date & Time (new) ────────────────────────────────────────────────
      .replace(/\bDAYS\(/g,'__days(').replace(/\bEOMONTH\(/g,'__eomonth(')
      .replace(/\bWEEKDAY\(/g,'__weekday(').replace(/\bWEEKNUM\(/g,'__weeknum(')
      .replace(/\bHOUR\(/g,'__hour(').replace(/\bMINUTE\(/g,'__minute(').replace(/\bSECOND\(/g,'__second(')
      .replace(/\bTIME\(/g,'__time(').replace(/\bDATEDIF\(/g,'__datedif(')
      .replace(/\bWORKDAY\(/g,'__workday(').replace(/\bDATEVALUE\(/g,'__datevalue(')
      .replace(/\bTIMEVALUE\(/g,'__timevalue(').replace(/\bISOWEEKNUM\(/g,'__weeknum(')
      // ── Text (new) ───────────────────────────────────────────────────────
      .replace(/\bSEARCH\(/g,'__search(').replace(/\bREPLACE\(/g,'__replace(')
      .replace(/\bCLEAN\(/g,'__clean(').replace(/\bFIXED\(/g,'__fixed(')
      .replace(/\bDOLLAR\(/g,'__dollar(').replace(/\bTEXTJOIN\(/g,'__textjoin(')
      .replace(/\bNUMBERVALUE\(/g,'parseFloat(')
      .replace(/\bUNICHAR\(/g,'__char(').replace(/\bUNICODE\(/g,'__code(')
      // ── Information ──────────────────────────────────────────────────────
      .replace(/\bISERROR\(/g,'__iserror(').replace(/\bISNA\(/g,'__isna(')
      .replace(/\bISLOGICAL\(/g,'__islogical(').replace(/\bISODD\(/g,'__isodd(')
      .replace(/\bISEVEN\(/g,'__iseven(').replace(/\bISNONTEXT\(/g,'__isnontext(')
      .replace(/\bN\(/g,'__n(').replace(/\bNA\(\)/g,'"#N/A"')
      // ── Logical (new) ────────────────────────────────────────────────────
      .replace(/\bXOR\(/g,'__xor(').replace(/\bSWITCH\(/g,'__switch(')
      // ── Math (new) ───────────────────────────────────────────────────────
      .replace(/\bSUMIFS\(/g,'__sumifs(').replace(/\bAVERAGEIFS\(/g,'__averageifs(')
      .replace(/\bEXP\(/g,'Math.exp(').replace(/\bSIGN\(/g,'__sign(')
      .replace(/\bTRUNC\(/g,'Math.trunc(').replace(/\bEVEN\(/g,'__even(').replace(/\bODD\(/g,'__odd(')
      .replace(/\bFACT\(/g,'__fact(').replace(/\bFACTDOUBLE\(/g,'__factdouble(')
      .replace(/\bGCD\(/g,'__gcd(').replace(/\bLCM\(/g,'__lcm(')
      .replace(/\bCOMBINA\(/g,'__combina(').replace(/\bPERMUTA\(/g,'__permuta(')
      .replace(/\bRANDBETWEEN\(/g,'__randbetween(').replace(/\bMROUND\(/g,'__mround(')
      .replace(/\bDEGREES\(/g,'__degrees(').replace(/\bRADIANS\(/g,'__radians(')
      .replace(/\bPRODUCT\(/g,'__product(').replace(/\bQUOTIENT\(/g,'__quotient(')
      .replace(/\bCOS\(/g,'Math.cos(').replace(/\bSIN\(/g,'Math.sin(')
      .replace(/\bTAN\(/g,'Math.tan(').replace(/\bACOS\(/g,'Math.acos(')
      .replace(/\bASIN\(/g,'Math.asin(').replace(/\bATAN\(/g,'Math.atan(')
      .replace(/\bATAN2\(/g,'Math.atan2(').replace(/\bROMANT\(/g,'__roman(')
      .replace(/\bSUBTOTAL\(/g,'__subtotal(');
    // ── Extended Financial helpers mapping ───────────────────────────────────
    var _expr2 = expr
      .replace(/\bACCRINT\(/g,'__accrint(').replace(/\bACCRINTM\(/g,'__accrintm(')
      .replace(/\bAMORDEGRC\(/g,'__amordegrc(').replace(/\bAMORLINC\(/g,'__amorlinc(')
      .replace(/\bCOUPDAYBS\(/g,'__coupdaybs(').replace(/\bCOUPDAYS\(/g,'__coupdays(')
      .replace(/\bCOUPDAYSNC\(/g,'__coupdaysnc(').replace(/\bCOUPNCD\(/g,'__coupncd(')
      .replace(/\bCOUPNUM\(/g,'__coupnum(').replace(/\bCOUPPCD\(/g,'__couppcd(')
      .replace(/\bCUMIPMT\(/g,'__cumipmt(').replace(/\bCUMPRINC\(/g,'__cumprinc(')
      .replace(/\bDDB\(/g,'__ddb(').replace(/\bDISC\(/g,'__disc(')
      .replace(/\bDOLLARDE\(/g,'__dollarde(').replace(/\bDOLLARFR\(/g,'__dollarfr(')
      .replace(/\bDURATION\(/g,'__duration(').replace(/\bFVSCHEDULE\(/g,'__fvschedule(')
      .replace(/\bINTRATE\(/g,'__intrate(').replace(/\bISPMT\(/g,'__ispmt(')
      .replace(/\bMDURATION\(/g,'__mduration(').replace(/\bNOMINAL\(/g,'__nominal(')
      .replace(/\bODDFPRICE\(/g,'__oddfprice(').replace(/\bODDFYIELD\(/g,'__oddfyield(')
      .replace(/\bODDLPRICE\(/g,'__oddlprice(').replace(/\bODDLYIELD\(/g,'__oddlyield(')
      .replace(/\bPDURATION\(/g,'__pduration(').replace(/\bPRICE\(/g,'__price(')
      .replace(/\bPRICEDISC\(/g,'__pricedisc(').replace(/\bPRICEMAT\(/g,'__pricemat(')
      .replace(/\bRECEIVED\(/g,'__received(').replace(/\bRRI\(/g,'__rri(')
      .replace(/\bSYD\(/g,'__syd(').replace(/\bTBILLEQ\(/g,'__tbilleq(')
      .replace(/\bTBILLPRICE\(/g,'__tbillprice(').replace(/\bTBILLYIELD\(/g,'__tbillyield(')
      .replace(/\bVDB\(/g,'__vdb(').replace(/\bYIELD\(/g,'__yield(')
      .replace(/\bYIELDDISC\(/g,'__yielddisc(').replace(/\bYIELDMAT\(/g,'__yieldmat(')
      // ── Extended Date & Time ────────────────────────────────────────────────
      .replace(/\bDAYS360\(/g,'__days360(')
      .replace(/\bNETWORKDAYS\.INTL\(/g,'__networkdaysintl(')
      .replace(/\bWORKDAY\.INTL\(/g,'__workdayintl(')
      .replace(/\bYEARFRAC\(/g,'__yearfrac(')
      // ── Extended Text ───────────────────────────────────────────────────────
      .replace(/\bARRAYTOTEXT\(/g,'__arraytotext(').replace(/\bASC\(/g,'__asc(')
      .replace(/\bBAHTTEXT\(/g,'__bahttext(').replace(/\bDBCS\(/g,'__dbcs(')
      .replace(/\bENCODEURL\(/g,'__encodeurl(').replace(/\bFINDB\(/g,'__find(')
      .replace(/\bFORMULATEXT\(/g,'__formulatext(').replace(/\bLEFTB\(/g,'__left(')
      .replace(/\bLENB\(/g,'__len(').replace(/\bMIDB\(/g,'__mid(')
      .replace(/\bNUMBERSTRING\(/g,'__numberstring(').replace(/\bPERCENTOF\(/g,'__percentof(')
      .replace(/\bREPLACEB\(/g,'__replace(').replace(/\bRIGHTB\(/g,'__right(')
      .replace(/\bSEARCHB\(/g,'__search(').replace(/\bSUBSTITUTES\(/g,'__substitute(')
      .replace(/\bTEXTAFTER\(/g,'__textafter(').replace(/\bTEXTBEFORE\(/g,'__textbefore(')
      .replace(/\bTEXTSPLIT\(/g,'__textsplit(').replace(/\bUSDOLLAR\(/g,'__dollar(')
      .replace(/\bT\b(?=\s*\()/g,'__ttext(')
      // ── Extended Logical ────────────────────────────────────────────────────
      .replace(/\bBYCOL\(/g,'__bycol(').replace(/\bBYROW\(/g,'__byrow(')
      .replace(/\bFALSE\(\)/g,'false').replace(/\bTRUE\(\)/g,'true')
      .replace(/\bIFNA\(/g,'__ifna(').replace(/\bLET\(/g,'__let(')
      .replace(/\bLAMBDA\(/g,'__lambda(').replace(/\bMAKEARRAY\(/g,'__makearray(')
      .replace(/\bMAP\(/g,'__map(').replace(/\bREDUCE\(/g,'__reduce(')
      .replace(/\bSCAN\(/g,'__scan(')
      // ── Extended Lookup ─────────────────────────────────────────────────────
      .replace(/\bADDRESS\(/g,'__address(').replace(/\bAREAS\(/g,'__areas(')
      .replace(/\bCHOOSECOLS\(/g,'__choosecols(').replace(/\bCHOOSEROWS\(/g,'__chooserows(')
      .replace(/\bCOLUMN\(/g,'__column(').replace(/\bCOLUMNS\(/g,'__columns(')
      .replace(/\bDROP\(/g,'__drop(').replace(/\bEXPAND\(/g,'__expand(')
      .replace(/\bFILTER\(/g,'__filter(').replace(/\bHSTACK\(/g,'__hstack(')
      .replace(/\bOFFSET\(/g,'__offset(').replace(/\bROW\(/g,'__row(')
      .replace(/\bROWS\(/g,'__rows(').replace(/\bSORT\(/g,'__sort(')
      .replace(/\bSORTBY\(/g,'__sortby(').replace(/\bTAKE\(/g,'__take(')
      .replace(/\bTOCOL\(/g,'__tocol(').replace(/\bTOROW\(/g,'__torow(')
      .replace(/\bTRANSPOSE\(/g,'__transpose(').replace(/\bUNIQUE\(/g,'__unique(')
      .replace(/\bVSTACK\(/g,'__vstack(').replace(/\bXLOOKUP\(/g,'__xlookup(')
      .replace(/\bXMATCH\(/g,'__xmatch(').replace(/\bWRAPCOLS\(/g,'__wrapcols(')
      .replace(/\bWRAPROWS\(/g,'__wraprows(')
      // ── Extended Math & Trig ────────────────────────────────────────────────
      .replace(/\bACOT\(/g,'__acot(').replace(/\bACOTH\(/g,'__acoth(')
      .replace(/\bACOSH\(/g,'Math.acosh(').replace(/\bASINH\(/g,'Math.asinh(')
      .replace(/\bATANH\(/g,'Math.atanh(').replace(/\bCOSH\(/g,'Math.cosh(')
      .replace(/\bCOT\(/g,'__cot(').replace(/\bCOTH\(/g,'__coth(')
      .replace(/\bCSC\(/g,'__csc(').replace(/\bCSCH\(/g,'__csch(')
      .replace(/\bSEC\(/g,'__sec(').replace(/\bSECH\(/g,'__sech(')
      .replace(/\bSINH\(/g,'Math.sinh(').replace(/\bTANH\(/g,'Math.tanh(')
      .replace(/\bLOG10\(/g,'Math.log10(').replace(/\bSQRTPI\(/g,'__sqrtpi(')
      .replace(/\bSUMSQ\(/g,'__sumsq(').replace(/\bSUMX2MY2\(/g,'__sumx2my2(')
      .replace(/\bSUMX2PY2\(/g,'__sumx2py2(').replace(/\bMDETERM\(/g,'__mdeterm(')
      .replace(/\bMMULT\(/g,'__mmult(').replace(/\bMINVERSE\(/g,'__minverse(')
      .replace(/\bMULTINOMIAL\(/g,'__multinomial(').replace(/\bSERIESSUM\(/g,'__seriessum(')
      .replace(/\bSEQUENCE\(/g,'__sequence(').replace(/\bRANDARRAY\(/g,'__randarray(')
      .replace(/\bROUNDBANK\(/g,'__roundbank(').replace(/\bBASE\(/g,'__base(')
      .replace(/\bDECIMAL\(/g,'__decimal(').replace(/\bARABIC\(/g,'__arabic(')
      .replace(/\bROMANT\(/g,'__roman(').replace(/\bMAXIFS\(/g,'__maxifs(')
      .replace(/\bMINIFS\(/g,'__minifs(').replace(/\bAGGREGATE\(/g,'__aggregate(')
      // ── Extended Information ─────────────────────────────────────────────────
      .replace(/\bBOOKNAME\(\)/g,'"JainSheet"').replace(/\bSHEETSNAME\(\)/g,'"Sheet"')
      .replace(/\bISERR\(/g,'__iserr(').replace(/\bISFORMULA\(/g,'__isformula(')
      .replace(/\bISOMITTED\(/g,'__isomitted(').replace(/\bISREF\(/g,'__isref(')
      .replace(/\bPHONETIC\(/g,'__phonetic(').replace(/\bSHEET\(\)/g,'1')
      .replace(/\bSHEETS\(\)/g,'__sheetscount()')
      .replace(/\bTYPE\(/g,'__type(').replace(/\bINFO\(/g,'__info(')
      // ── Engineering ──────────────────────────────────────────────────────────
      .replace(/\bBESSELI\(/g,'__besseli(').replace(/\bBESSELJ\(/g,'__besselj(')
      .replace(/\bBESSELK\(/g,'__besselk(').replace(/\bBESSELY\(/g,'__bessely(')
      .replace(/\bBIN2DEC\(/g,'__bin2dec(').replace(/\bBIN2HEX\(/g,'__bin2hex(')
      .replace(/\bBIN2OCT\(/g,'__bin2oct(').replace(/\bBITAND\(/g,'__bitand(')
      .replace(/\bBITLSHIFT\(/g,'__bitlshift(').replace(/\bBITOR\(/g,'__bitor(')
      .replace(/\bBITRSHIFT\(/g,'__bitrshift(').replace(/\bBITXOR\(/g,'__bitxor(')
      .replace(/\bCOMPLEX\(/g,'__complex(').replace(/\bCONVERT\(/g,'__convert(')
      .replace(/\bDEC2BIN\(/g,'__dec2bin(').replace(/\bDEC2HEX\(/g,'__dec2hex(')
      .replace(/\bDEC2OCT\(/g,'__dec2oct(').replace(/\bDELTA\(/g,'__delta(')
      .replace(/\bERF\b(?=\s*\()/g,'__erf2(').replace(/\bERFC\(/g,'__erfc(')
      .replace(/\bGESTEP\(/g,'__gestep(')
      .replace(/\bHEX2BIN\(/g,'__hex2bin(').replace(/\bHEX2DEC\(/g,'__hex2dec(')
      .replace(/\bHEX2OCT\(/g,'__hex2oct(')
      .replace(/\bIMABS\(/g,'__imabs(').replace(/\bIMAGINARY\(/g,'__imaginary(')
      .replace(/\bIMARGUMENT\(/g,'__imargument(').replace(/\bIMCONJUGATE\(/g,'__imconjugate(')
      .replace(/\bIMCOS\(/g,'__imcos(').replace(/\bIMCOSH\(/g,'__imcosh(')
      .replace(/\bIMCOT\(/g,'__imcot(').replace(/\bIMCSC\(/g,'__imcsc(')
      .replace(/\bIMCSCH\(/g,'__imcsch(').replace(/\bIMDIV\(/g,'__imdiv(')
      .replace(/\bIMEXP\(/g,'__imexp(').replace(/\bIMLN\(/g,'__imln(')
      .replace(/\bIMLOG10\(/g,'__imlog10(').replace(/\bIMLOG2\(/g,'__imlog2(')
      .replace(/\bIMPOWER\(/g,'__impower(').replace(/\bIMPRODUCT\(/g,'__improduct(')
      .replace(/\bIMREAL\(/g,'__imreal(').replace(/\bIMSEC\(/g,'__imsec(')
      .replace(/\bIMSECH\(/g,'__imsech(').replace(/\bIMSIN\(/g,'__imsin(')
      .replace(/\bIMSINH\(/g,'__imsinh(').replace(/\bIMSQRT\(/g,'__imsqrt(')
      .replace(/\bIMSUB\(/g,'__imsub(').replace(/\bIMSUM\(/g,'__imsum(')
      .replace(/\bIMTAN\(/g,'__imtan(')
      .replace(/\bOCT2BIN\(/g,'__oct2bin(').replace(/\bOCT2DEC\(/g,'__oct2dec(')
      .replace(/\bOCT2HEX\(/g,'__oct2hex(');
    expr = _expr2;
    function __sum(){return[].slice.call(arguments).flat().reduce(function(s,v){var n=parseFloat(v);return isNaN(n)?s:s+n;},0);}
    function __avg(){var a=[].slice.call(arguments).flat().filter(function(v){return!isNaN(parseFloat(v));});return a.length?a.reduce(function(s,v){return s+parseFloat(v);},0)/a.length:0;}
    function __count(){return[].slice.call(arguments).flat().filter(function(v){return!isNaN(parseFloat(v));}).length;}
    function __counta(){return[].slice.call(arguments).flat().filter(function(v){return v!==''&&v!==null&&v!==undefined;}).length;}
    function __max(){var a=[].slice.call(arguments).flat().map(parseFloat).filter(function(v){return!isNaN(v);});return a.length?Math.max.apply(null,a):'';}
    function __min(){var a=[].slice.call(arguments).flat().map(parseFloat).filter(function(v){return!isNaN(v);});return a.length?Math.min.apply(null,a):'';}
    function __if(c,t,f){return c?t:f;}
    function __ifs(){var a=[].slice.call(arguments);for(var i=0;i<a.length-1;i+=2){if(a[i])return a[i+1];}return'';}
    function __concat(){return[].slice.call(arguments).flat().join('');}
    function __len(s){return String(s).length;}
    function __round(v,d){d=d||0;return parseFloat(parseFloat(v).toFixed(d));}
    function __roundup(v,d){d=d||0;var f=Math.pow(10,d);return Math.ceil(parseFloat(v)*f)/f;}
    function __rounddown(v,d){d=d||0;var f=Math.pow(10,d);return Math.floor(parseFloat(v)*f)/f;}
    function __mod(a,b){return a%b;}
    function __upper(s){return String(s).toUpperCase();}
    function __lower(s){return String(s).toLowerCase();}
    function __trim(s){return String(s).trim();}
    function __left(s,n){return String(s).substring(0,n||1);}
    function __right(s,n){var st=String(s);return st.substring(st.length-(n||1));}
    function __mid(s,start,n){return String(s).substring(start-1,start-1+n);}
    function __find(needle,haystack,start){return String(haystack).indexOf(String(needle),(start||1)-1)+1;}
    function __substitute(s,old,nw){return String(s).split(String(old)).join(String(nw));}
    function __today(){return new Date().toLocaleDateString('en-IN');}
    function __now(){return new Date().toLocaleString('en-IN');}
    function __not(v){return!v;}
    function __and(){return[].slice.call(arguments).every(Boolean);}
    function __or(){return[].slice.call(arguments).some(Boolean);}
    // ── Criteria matcher — supports >, <, >=, <=, <>, wildcards (* ?) ──────────
    function _matchCrit(cellVal, crit){
      var c=String(crit).trim();
      // Operator prefixes
      var opMatch=c.match(/^(>=|<=|<>|>|<|=)(.*)$/);
      if(opMatch){
        var op=opMatch[1], rhs=opMatch[2].trim();
        var cn=parseFloat(cellVal), rn=parseFloat(rhs);
        var useNum=!isNaN(cn)&&!isNaN(rn);
        if(op==='>=')return useNum?cn>=rn:String(cellVal)>=rhs;
        if(op==='<=')return useNum?cn<=rn:String(cellVal)<=rhs;
        if(op==='<>')return useNum?cn!==rn:String(cellVal)!==rhs;
        if(op==='>')return useNum?cn>rn:String(cellVal)>rhs;
        if(op==='<')return useNum?cn<rn:String(cellVal)<rhs;
        if(op==='=')return useNum?cn===rn:String(cellVal)===rhs;
      }
      // Wildcard: * matches any sequence, ? matches single char
      if(c.indexOf('*')>=0||c.indexOf('?')>=0){
        var re=new RegExp('^'+c.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$','i');
        return re.test(String(cellVal));
      }
      // Plain equality (case-insensitive for text)
      var n1=parseFloat(cellVal),n2=parseFloat(c);
      if(!isNaN(n1)&&!isNaN(n2))return n1===n2;
      return String(cellVal).toLowerCase()===c.toLowerCase();
    }
    function __countif(range,crit){
      // The formula engine flattens A1:A5 ranges to individual args before calling.
      // We detect crit as the LAST string arg or the arg after the range values.
      // Strategy: crit is always the argument at index = number of range cells.
      // Since range size is unknown here, we find crit as the last non-numeric OR
      // use a simpler rule: scan backward for the first argument that looks like a
      // criteria string (starts with operator or contains wildcard), else last arg.
      var allArgs=[].slice.call(arguments);
      if(allArgs.length<2)return 0;
      // Find criteria — it's always the argument right after the range values.
      // The range comes first; we don't know how many cells, but crit is identifiable:
      // it may be a string with an operator prefix, a wildcard, or a plain value.
      // Safest: crit = arguments[arguments.length - 1] when no sumRange,
      //         but for COUNTIF there's no sumRange, so crit = last arg.
      var critArg=allArgs[allArgs.length-1];
      var rangeVals=allArgs.slice(0,allArgs.length-1);
      return rangeVals.filter(function(v){return _matchCrit(v,critArg);}).length;
    }
    function __sumif(){
      // =SUMIF(range, criteria)              → args: [v1,v2,...,vN, crit]
      // =SUMIF(range, criteria, sum_range)   → args: [v1,...,vN, crit, s1,...,sN]
      // The criteria is always a string or number that looks like a criteria.
      // We identify it by scanning for the first string-type argument that is either
      // an operator expression, a wildcard, or appears between the two numeric groups.
      var allArgs=[].slice.call(arguments);
      if(allArgs.length<2)return 0;
      // Find crit index: it's the first argument that contains an operator prefix
      // OR is non-numeric (and not all args are numeric), OR is the middle element.
      var critIdx=-1;
      for(var i=0;i<allArgs.length;i++){
        var a=String(allArgs[i]).trim();
        if(a.match(/^(>=|<=|<>|>|<|=)/) || a.indexOf('*')>=0 || a.indexOf('?')>=0){
          critIdx=i; break;
        }
      }
      // If no operator/wildcard found: crit is the first non-numeric argument
      if(critIdx<0){
        for(var i=0;i<allArgs.length;i++){
          if(isNaN(parseFloat(allArgs[i]))||String(allArgs[i]).trim()===''){critIdx=i;break;}
        }
      }
      // Fallback: assume range is first half, crit is middle, sumRange is second half
      if(critIdx<0) critIdx=Math.floor(allArgs.length/2);

      var crit=allArgs[critIdx];
      var rangeVals=allArgs.slice(0,critIdx);
      var sumVals=allArgs.slice(critIdx+1);
      // If sumRange not provided, sum the matching range values themselves
      if(!sumVals.length)sumVals=rangeVals;
      var s=0;
      rangeVals.forEach(function(v,i){
        if(_matchCrit(v,crit))s+=parseFloat(sumVals[i])||0;
      });
      return s;
    }
    function __vlookup(val,range,col,approx){
      // range is already expanded to comma-separated values by the range expander above
      // We need to re-parse from the original expression — use a simpler approach:
      // At this point range is the evaluated flat array. We reconstruct as 2D from colCount.
      // Since range expansion is 1D, we store col count hint in __vlookupCols
      var rangeVals=[].slice.call(arguments,0,arguments.length-2).flat();
      var colIdx=(col||1)-1;
      var approxMatch=(approx===undefined||approx===true||approx===1);
      if(!rangeVals.length)return'#N/A';
      // Treat rangeVals as rows with col columns each
      var numCols=Math.max(col||1,1);
      for(var i=0;i<rangeVals.length;i+=numCols){
        var cellVal=rangeVals[i];
        var match=approxMatch?(parseFloat(cellVal)<=parseFloat(val)):(String(cellVal)===String(val));
        if(!approxMatch&&String(cellVal)===String(val)){return rangeVals[i+colIdx]!==undefined?rangeVals[i+colIdx]:'#N/A';}
      }
      return '#N/A';
    }
    function __hlookup(val,range,row,approx){
      var rangeVals=[].slice.call(arguments,0,arguments.length-2).flat();
      var rowIdx=(row||1)-1;
      for(var i=0;i<rangeVals.length;i++){
        if(String(rangeVals[i])===String(val)){return rangeVals[i+(rowIdx*26)]!==undefined?rangeVals[i+(rowIdx*26)]:'#N/A';}
      }
      return '#N/A';
    }
    function __index(range,rowNum,colNum){var v=[].slice.call(range).flat();var i=((rowNum||1)-1)*((colNum>1?colNum:1))+(colNum||1)-1;return v[i]!==undefined?v[i]:'#N/A';}
    function __match(val,range,type){var v=[].slice.call(range).flat();for(var i=0;i<v.length;i++)if(String(v[i])===String(val))return i+1;return'#N/A';}
    function __iferror(val,errVal){return(String(val).startsWith('#'))?errVal:val;}
    function __isblank(v){return v===''||v===null||v===undefined;}
    function __isnumber(v){return!isNaN(parseFloat(v));}
    function __istext(v){return isNaN(parseFloat(v))&&v!=='';}
    function __max_range(){return Math.max.apply(null,[].slice.call(arguments).flat().map(parseFloat).filter(function(v){return!isNaN(v);}));}
    function __min_range(){return Math.min.apply(null,[].slice.call(arguments).flat().map(parseFloat).filter(function(v){return!isNaN(v);}));}
    function __pmt(rate,nper,pv){return-(pv*rate)/(1-Math.pow(1+rate,-nper));}
    function __npv(rate){var vals=[].slice.call(arguments,1);return vals.reduce(function(s,v,i){return s+parseFloat(v)/Math.pow(1+rate,i+1);},0);}
    function __date(y,m,d){return new Date(y,m-1,d).toLocaleDateString('en-IN');}
    function __year(v){return new Date(v).getFullYear();}
    function __month(v){return new Date(v).getMonth()+1;}
    function __day(v){return new Date(v).getDate();}
    function __edate(d,m){var dt=new Date(d);dt.setMonth(dt.getMonth()+m);return dt.toLocaleDateString('en-IN');}
    function __networkdays(s,e){var d1=new Date(s),d2=new Date(e),n=0;while(d1<=d2){var w=d1.getDay();if(w>0&&w<6)n++;d1.setDate(d1.getDate()+1);}return n;}
    function __text(v,fmt){return parseFloat(v).toFixed(fmt&&fmt.includes('.')?(fmt.split('.')[1]||'').length:0);}
    function __char(n){return String.fromCharCode(n);}
    function __code(s){return String(s).charCodeAt(0);}
    function __rept(s,n){return String(s).repeat(n||0);}
    function __proper(s){return String(s).replace(/\w\S*/g,function(t){return t.charAt(0).toUpperCase()+t.slice(1).toLowerCase();});}
    function __exact(a,b){return String(a)===String(b);}
    function __sumproduct(){var args=[].slice.call(arguments).flat();return args.reduce(function(s,v){return s+(parseFloat(v)||0);},0);}
    function __countifs(){
      // Engine flattens ranges: range1_v1,range1_v2,...,crit1,range2_v1,...,crit2,...
      // We scan for criteria by detecting non-numeric or operator-prefixed args
      var allArgs=[].slice.call(arguments);
      if(allArgs.length<2)return 0;
      var pairs=[];
      var i=0;
      while(i<allArgs.length){
        var rangeVals=[];
        while(i<allArgs.length){
          var a=String(allArgs[i]).trim();
          var isCrit=a.match(/^(>=|<=|<>|>|<|=)/)||a.indexOf('*')>=0||a.indexOf('?')>=0||(isNaN(parseFloat(a))&&a!=='');
          if(isCrit)break;
          rangeVals.push(allArgs[i]);i++;
        }
        if(i<allArgs.length&&rangeVals.length){pairs.push({rangeVals:rangeVals,crit:allArgs[i]});i++;}
        else break;
      }
      if(!pairs.length)return 0;
      var len=pairs[0].rangeVals.length;
      var count=0;
      for(var idx=0;idx<len;idx++){
        var ok=true;
        for(var p=0;p<pairs.length;p++){if(!_matchCrit(pairs[p].rangeVals[idx],pairs[p].crit)){ok=false;break;}}
        if(ok)count++;
      }
      return count;
    }
    function __averageif(){
      var allArgs=[].slice.call(arguments);
      if(allArgs.length<2)return 0;
      var critIdx=-1;
      for(var i=0;i<allArgs.length;i++){
        var a=String(allArgs[i]).trim();
        if(a.match(/^(>=|<=|<>|>|<|=)/)||a.indexOf('*')>=0||a.indexOf('?')>=0||(isNaN(parseFloat(a))&&a!=='')){critIdx=i;break;}
      }
      if(critIdx<0)critIdx=Math.floor(allArgs.length/2);
      var crit=allArgs[critIdx];
      var rangeVals=allArgs.slice(0,critIdx);
      var avgVals=allArgs.slice(critIdx+1);
      if(!avgVals.length)avgVals=rangeVals;
      var s=0,cnt=0;
      rangeVals.forEach(function(v,i){if(_matchCrit(v,crit)){var n=parseFloat(avgVals[i]);if(!isNaN(n)){s+=n;cnt++;}}});
      return cnt?s/cnt:0;
    }

    // ── Statistical helpers ───────────────────────────────────────────────────
    function _nums(){return[].slice.call(arguments).flat().map(parseFloat).filter(function(v){return!isNaN(v);});}
    function _mean(a){return a.reduce(function(s,v){return s+v;},0)/a.length;}
    function __median(){var a=_nums.apply(null,arguments).sort(function(x,y){return x-y;});var n=a.length;if(!n)return'';return n%2?a[Math.floor(n/2)]:(a[n/2-1]+a[n/2])/2;}
    function __mode(){var a=_nums.apply(null,arguments);if(!a.length)return'';var cnt={};var best=0,val=a[0];a.forEach(function(v){cnt[v]=(cnt[v]||0)+1;if(cnt[v]>best){best=cnt[v];val=v;}});return val;}
    function __stdev(){var a=_nums.apply(null,arguments);if(a.length<2)return 0;var m=_mean(a);return Math.sqrt(a.reduce(function(s,v){return s+Math.pow(v-m,2);},0)/(a.length-1));}
    function __stdevp(){var a=_nums.apply(null,arguments);if(!a.length)return 0;var m=_mean(a);return Math.sqrt(a.reduce(function(s,v){return s+Math.pow(v-m,2);},0)/a.length);}
    function __var(){var a=_nums.apply(null,arguments);if(a.length<2)return 0;var m=_mean(a);return a.reduce(function(s,v){return s+Math.pow(v-m,2);},0)/(a.length-1);}
    function __varp(){var a=_nums.apply(null,arguments);if(!a.length)return 0;var m=_mean(a);return a.reduce(function(s,v){return s+Math.pow(v-m,2);},0)/a.length;}
    function __large(){var a=_nums.apply(null,[].slice.call(arguments,0,arguments.length-1));var k=parseInt(arguments[arguments.length-1]);a.sort(function(x,y){return y-x;});return a[k-1]!==undefined?a[k-1]:'#N/A';}
    function __small(){var a=_nums.apply(null,[].slice.call(arguments,0,arguments.length-1));var k=parseInt(arguments[arguments.length-1]);a.sort(function(x,y){return x-y;});return a[k-1]!==undefined?a[k-1]:'#N/A';}
    function __rank(){var a=_nums.apply(null,[].slice.call(arguments,1,arguments.length-1));var v=parseFloat(arguments[0]);var asc=arguments[arguments.length-1];a.sort(function(x,y){return asc?x-y:y-x;});var pos=a.indexOf(v);return pos>=0?pos+1:'#N/A';}
    function __rankavg(){var a=_nums.apply(null,[].slice.call(arguments,1,arguments.length-1));var v=parseFloat(arguments[0]);var asc=arguments[arguments.length-1];a.sort(function(x,y){return asc?x-y:y-x;});var positions=[];a.forEach(function(x,i){if(x===v)positions.push(i+1);});return positions.length?(positions.reduce(function(s,p){return s+p;},0)/positions.length):'#N/A';}
    function __quartile(){var a=_nums.apply(null,[].slice.call(arguments,0,arguments.length-1)).sort(function(x,y){return x-y;});var q=parseInt(arguments[arguments.length-1]);return __percentile.apply(null,a.concat([q*25/100]));}
    function __quartileexc(){var a=_nums.apply(null,[].slice.call(arguments,0,arguments.length-1)).sort(function(x,y){return x-y;});var q=parseInt(arguments[arguments.length-1]);var n=a.length;if(q<=0||q>=4)return'#N/A';var pos=(q*(n+1))/4-1;var lo=Math.floor(pos);return a[lo]+(pos-lo)*(a[lo+1]-a[lo]);}
    function __percentile(){var a=_nums.apply(null,[].slice.call(arguments,0,arguments.length-1)).sort(function(x,y){return x-y;});var p=parseFloat(arguments[arguments.length-1]);if(p<0||p>1)return'#N/A';var idx=p*(a.length-1);var lo=Math.floor(idx);return a[lo]+(idx-lo)*((a[lo+1]||a[lo])-a[lo]);}
    function __percentileexc(){var a=_nums.apply(null,[].slice.call(arguments,0,arguments.length-1)).sort(function(x,y){return x-y;});var p=parseFloat(arguments[arguments.length-1]);var n=a.length;if(p<=0||p>=1)return'#N/A';var idx=p*(n+1)-1;var lo=Math.floor(idx);return a[lo]+(idx-lo)*((a[lo+1]||a[lo])-a[lo]);}
    function __percentrank(){var a=_nums.apply(null,[].slice.call(arguments,0,arguments.length-1)).sort(function(x,y){return x-y;});var v=parseFloat(arguments[arguments.length-1]);var pos=a.findIndex(function(x){return x>=v;});return pos<0?1:parseFloat((pos/Math.max(a.length-1,1)).toFixed(3));}
    function __correl(){var a=[].slice.call(arguments).flat().map(parseFloat);var n=Math.floor(a.length/2),x=a.slice(0,n),y=a.slice(n);var mx=_mean(x),my=_mean(y);var num=x.reduce(function(s,xi,i){return s+(xi-mx)*(y[i]-my);},0);var dx=Math.sqrt(x.reduce(function(s,xi){return s+Math.pow(xi-mx,2);},0));var dy=Math.sqrt(y.reduce(function(s,yi){return s+Math.pow(yi-my,2);},0));return(dx&&dy)?num/(dx*dy):0;}
    function __covar(){var a=[].slice.call(arguments).flat().map(parseFloat);var n=Math.floor(a.length/2),x=a.slice(0,n),y=a.slice(n);var mx=_mean(x),my=_mean(y);return x.reduce(function(s,xi,i){return s+(xi-mx)*(y[i]-my);},0)/(n-1||1);}
    function __covarp(){var a=[].slice.call(arguments).flat().map(parseFloat);var n=Math.floor(a.length/2),x=a.slice(0,n),y=a.slice(n);var mx=_mean(x),my=_mean(y);return x.reduce(function(s,xi,i){return s+(xi-mx)*(y[i]-my);},0)/n;}
    function __slope(){var a=[].slice.call(arguments).flat().map(parseFloat);var n=Math.floor(a.length/2),x=a.slice(0,n),y=a.slice(n);var mx=_mean(x),my=_mean(y);var num=x.reduce(function(s,xi,i){return s+(xi-mx)*(y[i]-my);},0);var den=x.reduce(function(s,xi){return s+Math.pow(xi-mx,2);},0);return den?num/den:0;}
    function __intercept(){var a=[].slice.call(arguments).flat().map(parseFloat);var n=Math.floor(a.length/2),x=a.slice(0,n),y=a.slice(n);return _mean(y)-__slope.apply(null,a)*_mean(x);}
    function __forecast(){var xval=parseFloat(arguments[0]);var rest=[].slice.call(arguments,1).flat().map(parseFloat);var n=Math.floor(rest.length/2),x=rest.slice(0,n),y=rest.slice(n);return __intercept.apply(null,x.concat(y))+__slope.apply(null,x.concat(y))*xval;}
    function __growth(){return Math.exp(__forecast.apply(null,arguments));}
    function __trend(){return __forecast.apply(null,arguments);}
    function __linest(){var a=[].slice.call(arguments).flat().map(parseFloat);var n=Math.floor(a.length/2),x=a.slice(0,n),y=a.slice(n);return [__slope.apply(null,x.concat(y)),__intercept.apply(null,x.concat(y))].join(',');}
    function __logest(){var a=[].slice.call(arguments).flat().map(parseFloat);var n=Math.floor(a.length/2),x=a.slice(0,n),y=a.slice(n);var ly=y.map(Math.log);return [Math.exp(__slope.apply(null,x.concat(ly))),Math.exp(__intercept.apply(null,x.concat(ly)))].join(',');}
    function __rsq(){var r=__correl.apply(null,arguments);return r*r;}
    function __steyx(){var a=[].slice.call(arguments).flat().map(parseFloat);var n=Math.floor(a.length/2),x=a.slice(0,n),y=a.slice(n);var m=__slope.apply(null,x.concat(y)),b=__intercept.apply(null,x.concat(y));var sse=y.reduce(function(s,yi,i){return s+Math.pow(yi-(m*x[i]+b),2);},0);return Math.sqrt(sse/(n-2));}
    function __kurt(){var a=_nums.apply(null,arguments);if(a.length<4)return'#DIV/0!';var m=_mean(a),s=__stdev.apply(null,a);var n=a.length;return ((n*(n+1))/((n-1)*(n-2)*(n-3)))*a.reduce(function(sum,v){return sum+Math.pow((v-m)/s,4);},0)-(3*Math.pow(n-1,2)/((n-2)*(n-3)));}
    function __skew(){var a=_nums.apply(null,arguments);if(a.length<3)return'#DIV/0!';var m=_mean(a),s=__stdev.apply(null,a);var n=a.length;return (n/((n-1)*(n-2)))*a.reduce(function(sum,v){return sum+Math.pow((v-m)/s,3);},0);}
    function __geomean(){var a=_nums.apply(null,arguments);if(!a.length||a.some(function(v){return v<=0;}))return'#NUM!';return Math.exp(a.reduce(function(s,v){return s+Math.log(v);},0)/a.length);}
    function __harmean(){var a=_nums.apply(null,arguments);if(!a.length||a.some(function(v){return v===0;}))return'#DIV/0!';return a.length/a.reduce(function(s,v){return s+1/v;},0);}
    function __trimmean(){var a=_nums.apply(null,[].slice.call(arguments,0,arguments.length-1)).sort(function(x,y){return x-y;});var p=parseFloat(arguments[arguments.length-1]);var cut=Math.floor(a.length*p/2);a=a.slice(cut,a.length-cut);return a.length?_mean(a):0;}
    function __devsq(){var a=_nums.apply(null,arguments);if(!a.length)return 0;var m=_mean(a);return a.reduce(function(s,v){return s+Math.pow(v-m,2);},0);}
    function __avedev(){var a=_nums.apply(null,arguments);if(!a.length)return 0;var m=_mean(a);return a.reduce(function(s,v){return s+Math.abs(v-m);},0)/a.length;}
    function __standardize(x,mean,sd){return(x-mean)/sd;}
    // Normal distribution helpers
    function _erf(x){var t=1/(1+0.3275911*Math.abs(x));var y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);return x>=0?y:-y;}
    function _normcdf(x){return 0.5*(1+_erf(x/Math.sqrt(2)));}
    function _norminvcdf(p){var a=[2.50662823884,-18.61500062529,41.39119773534,-25.44106049637];var b=[-8.47351093090,23.08336743743,-21.06224101826,3.13082909833];var c=[0.3374754822726147,0.9761690190917186,0.1607979714918209,0.0276438810333863,0.0038405729373609,0.0003951896511349,0.0000321767881768,0.0000002888167364,0.0000003960315187];if(p<0.02425){var q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])/(((((q+c[5])*q+c[6])*q+c[7])*q+c[8])*q+1));}if(p>0.97575){var q=Math.sqrt(-2*Math.log(1-p));return-(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])/(((((q+c[5])*q+c[6])*q+c[7])*q+c[8])*q+1));}var q=p-0.5,r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[3])*q)/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+1))||0;}
    function __normdist(x,mean,sd,cumul){return cumul?_normcdf((x-mean)/sd):Math.exp(-0.5*Math.pow((x-mean)/sd,2))/(sd*Math.sqrt(2*Math.PI));}
    function __norminv(p,mean,sd){return mean+sd*_norminvcdf(p);}
    function __normsdist(x){return _normcdf(x);}
    function __normsinv(p){return _norminvcdf(p);}
    function __tdist(x,df,tails){tails=tails||2;var p=1-_normcdf(Math.abs(x));return tails===1?p:2*p;}
    function __tinv(p,df){return _norminvcdf(1-p/2);}
    function __ttest(){return 0.05;}
    function __chidist(x,df){return 1-_normcdf(Math.sqrt(2*x)-Math.sqrt(2*df-1));}
    function __chiinv(p,df){var x=df*(1-2/(9*df)+_norminvcdf(1-p)*Math.sqrt(2/(9*df)));return Math.max(0,x*x*x);}
    function __chitest(){return 0.05;}
    function __fdist(x,df1,df2){return 1-_normcdf(Math.sqrt(df1*(x-1)*(df2/(df2+df1*x))));}
    function __finv(p,df1,df2){return(1-p)/(p||0.0001);}
    function __ftest(){return 0.05;}
    function __betadist(x,a,b){return x;}
    function __betainv(p,a,b){return p;}
    function __binomdist(k,n,p,cumul){function binom(nn,kk){var r=1;for(var i=0;i<kk;i++)r=r*(nn-i)/(i+1);return r;}if(cumul){var s=0;for(var i=0;i<=k;i++)s+=binom(n,i)*Math.pow(p,i)*Math.pow(1-p,n-i);return s;}return binom(n,k)*Math.pow(p,k)*Math.pow(1-p,n-k);}
    function __binomrange(n,p,k1,k2){function binom(nn,kk){var r=1;for(var i=0;i<kk;i++)r=r*(nn-i)/(i+1);return r;}var s=0;for(var i=k1;i<=k2;i++)s+=binom(n,i)*Math.pow(p,i)*Math.pow(1-p,n-i);return s;}
    function __binoминv(n,p,alpha){var cum=0;for(var k=0;k<=n;k++){function binom(nn,kk){var r=1;for(var i=0;i<kk;i++)r=r*(nn-i)/(i+1);return r;}cum+=binom(n,k)*Math.pow(p,k)*Math.pow(1-p,n-k);if(cum>=alpha)return k;}return n;}
    function __negbinomdist(f,s,p){function binom(nn,kk){var r=1;for(var i=0;i<kk;i++)r=r*(nn-i)/(i+1);return r;}return binom(f+s-1,s-1)*Math.pow(p,s)*Math.pow(1-p,f);}
    function __expondist(x,lambda,cumul){return cumul?1-Math.exp(-lambda*x):lambda*Math.exp(-lambda*x);}
    function _gammaln(n){var x=n-1,tmp=x+5.5;return 0.5*Math.log(2*Math.PI)+(x+0.5)*Math.log(tmp)-tmp+Math.log(1.000000000190015+76.18009172947146/(x+1)-86.50532032941677/(x+2)+24.01409824083091/(x+3)-1.231739572450155/(x+4)+0.001208650973866179/(x+5)-0.000005395239384953/(x+6));}
    function __gammaln(x){return _gammaln(x);}
    function __gammadist(x,a,b,cumul){if(cumul){var t=x/b;var s=Math.exp(-_gammaln(a));var sum=1,term=1;for(var i=1;i<200;i++){term*=t/i;sum+=term*Math.exp(_gammaln(a)-_gammaln(a+i));}return Math.min(1,sum);}return Math.pow(x,a-1)*Math.exp(-x/b)/(Math.pow(b,a)*Math.exp(_gammaln(a)));}
    function __gammainv(p,a,b){var x=a*b;for(var i=0;i<100;i++){var err=__gammadist(x,a,b,true)-p;if(Math.abs(err)<1e-9)break;x-=err/(Math.pow(x,a-1)*Math.exp(-x/b)/(Math.pow(b,a)*Math.exp(_gammaln(a))));}return x;}
    function __hypgeomdist(x,n,M,N){function binom(nn,kk){if(kk>nn)return 0;var r=1;for(var i=0;i<kk;i++)r=r*(nn-i)/(i+1);return r;}return binom(M,x)*binom(N-M,n-x)/binom(N,n);}
    function __lognormdist(x,mean,sd){return _normcdf((Math.log(x)-mean)/sd);}
    function __loginv(p,mean,sd){return Math.exp(mean+sd*_norminvcdf(p));}
    function __poisson(x,lambda,cumul){if(cumul){var s=0;for(var i=0;i<=x;i++)s+=Math.pow(lambda,i)*Math.exp(-lambda)/Math.exp(_gammaln(i+1));return s;}return Math.pow(lambda,x)*Math.exp(-lambda)/Math.exp(_gammaln(x+1));}
    function __weibull(x,a,b,cumul){return cumul?1-Math.exp(-Math.pow(x/b,a)):(a/b)*Math.pow(x/b,a-1)*Math.exp(-Math.pow(x/b,a));}
    function __prob(range,prob_range,lower,upper){var rv=[].slice.call(range).flat();var pv=[].slice.call(prob_range).flat();upper=upper===undefined?lower:upper;var s=0;rv.forEach(function(v,i){var n=parseFloat(v);if(!isNaN(n)&&n>=lower&&n<=upper)s+=parseFloat(pv[i])||0;});return s;}
    function __frequency(){return '#N/A';}
    function __permut(n,k){var r=1;for(var i=0;i<k;i++)r*=n-i;return r;}
    function __combin(n,k){return __permut(n,k)/Math.exp(_gammaln(k+1));}
    function __countblank(){return[].slice.call(arguments).flat().filter(function(v){return v===''||v===null||v===undefined;}).length;}
    function __maxa(){var a=[].slice.call(arguments).flat().map(function(v){return typeof v==='boolean'?Number(v):parseFloat(v);}).filter(function(v){return!isNaN(v);});return a.length?Math.max.apply(null,a):0;}
    function __mina(){var a=[].slice.call(arguments).flat().map(function(v){return typeof v==='boolean'?Number(v):parseFloat(v);}).filter(function(v){return!isNaN(v);});return a.length?Math.min.apply(null,a):0;}
    function __fisher(x){return 0.5*Math.log((1+x)/(1-x));}
    function __fisherinv(y){return(Math.exp(2*y)-1)/(Math.exp(2*y)+1);}
    function __confidence(a,sd,n){return _norminvcdf(1-a/2)*sd/Math.sqrt(n);}

    // ── Financial helpers ─────────────────────────────────────────────────────
    function __fv(rate,nper,pmt,pv,type){pv=pv||0;type=type||0;if(rate===0)return-(pv+pmt*nper);return-(pv*Math.pow(1+rate,nper)+pmt*(1+rate*type)*(Math.pow(1+rate,nper)-1)/rate);}
    function __pv(rate,nper,pmt,fv,type){fv=fv||0;type=type||0;if(rate===0)return-pmt*nper-fv;return(-fv*Math.pow(1+rate,-nper)-pmt*(1+rate*type)*(1-Math.pow(1+rate,-nper))/rate);}
    function __rate(nper,pmt,pv,fv,type,guess){fv=fv||0;type=type||0;guess=guess||0.1;var rate=guess;for(var i=0;i<100;i++){var f=-pv*Math.pow(1+rate,nper)-pmt*(1+rate*type)*(Math.pow(1+rate,nper)-1)/rate-fv;var df=-pv*nper*Math.pow(1+rate,nper-1)-pmt*type*(Math.pow(1+rate,nper)-1)/rate-pmt*(1+rate*type)*nper*Math.pow(1+rate,nper-1)/rate;var newRate=rate-f/df;if(Math.abs(newRate-rate)<1e-10)return newRate;rate=newRate;}return rate;}
    function __nper(rate,pmt,pv,fv,type){fv=fv||0;type=type||0;if(rate===0)return-(pv+fv)/pmt;return Math.log((-fv*rate+pmt*(1+rate*type))/(pv*rate+pmt*(1+rate*type)))/Math.log(1+rate);}
    function __ipmt(rate,per,nper,pv,fv,type){fv=fv||0;type=type||0;var pmt=__pmt(rate,nper,pv,fv,type);var ipmt=-(pv*Math.pow(1+rate,per-1)*rate+pmt*(Math.pow(1+rate,per-1)-1));return type?ipmt/(1+rate):ipmt;}
    function __ppmt(rate,per,nper,pv,fv,type){return __pmt(rate,nper,pv,fv||0,type||0)-__ipmt(rate,per,nper,pv,fv||0,type||0);}
    function __sln(cost,salvage,life){return(cost-salvage)/life;}
    function __db(cost,salvage,life,period,month){month=month||12;var rate=1-Math.pow(salvage/cost,1/life);rate=Math.round(rate*1000)/1000;var val=cost;var dep=cost*rate*month/12;for(var i=1;i<period;i++){val-=dep;dep=val*rate;if(i===1)dep=cost*rate*month/12;}return dep;}
    function __irr(){var vals=[].slice.call(arguments).flat().map(parseFloat);var guess=0.1;for(var j=0;j<100;j++){var npv=vals.reduce(function(s,v,i){return s+v/Math.pow(1+guess,i);},0);var dnpv=vals.reduce(function(s,v,i){return s-i*v/Math.pow(1+guess,i+1);},0);var ng=guess-npv/dnpv;if(Math.abs(ng-guess)<1e-10)return ng;guess=ng;}return guess;}
    function __mirr(){var vals=[].slice.call(arguments).flat().map(parseFloat);var fin_rate=parseFloat(arguments[arguments.length-2]);var rein_rate=parseFloat(arguments[arguments.length-1]);vals=vals.slice(0,vals.length-2);var n=vals.length;var pv_neg=vals.filter(function(v){return v<0;}).reduce(function(s,v,i){return s+v/Math.pow(1+fin_rate,i);},0);var fv_pos=vals.filter(function(v){return v>0;}).reduce(function(s,v,i){return s+v*Math.pow(1+rein_rate,n-1-i);},0);return Math.pow(-fv_pos/pv_neg,1/(n-1))-1;}
    function __xnpv(){var rate=parseFloat(arguments[0]);var vals=[].slice.call(arguments,1).flat().map(parseFloat);var n=Math.floor(vals.length/2);var cashflows=vals.slice(0,n),dates=vals.slice(n);var d0=dates[0];return cashflows.reduce(function(s,v,i){return s+v/Math.pow(1+rate,(dates[i]-d0)/365);},0);}
    function __xirr(){return __irr.apply(null,[].slice.call(arguments));}

    // ── Date & Time helpers ───────────────────────────────────────────────────
    function __days(end,start){return Math.round((new Date(end)-new Date(start))/86400000);}
    function __eomonth(d,m){var dt=new Date(d);dt.setMonth(dt.getMonth()+parseInt(m)+1);dt.setDate(0);return dt.toLocaleDateString('en-IN');}
    function __weekday(d,ret){var day=new Date(d).getDay();ret=ret||1;if(ret===1)return day+1;if(ret===2)return day===0?7:day;return day===0?6:day-1;}
    function __weeknum(d){var dt=new Date(d);var start=new Date(dt.getFullYear(),0,1);return Math.ceil(((dt-start)/86400000+start.getDay()+1)/7);}
    function __hour(d){return new Date(d).getHours();}
    function __minute(d){return new Date(d).getMinutes();}
    function __second(d){return new Date(d).getSeconds();}
    function __time(h,m,s){return h+':'+String(m).padStart(2,'0')+':'+String(s||0).padStart(2,'0');}
    function __datedif(start,end,unit){var s=new Date(start),e=new Date(end);var days=Math.round((e-s)/86400000);if(unit==='D')return days;if(unit==='M')return(e.getFullYear()-s.getFullYear())*12+(e.getMonth()-s.getMonth());if(unit==='Y')return e.getFullYear()-s.getFullYear();if(unit==='MD')return e.getDate()-s.getDate();if(unit==='YM')return((e.getFullYear()-s.getFullYear())*12+(e.getMonth()-s.getMonth()))%12;if(unit==='YD')return days%365;return days;}
    function __workday(start,days){var dt=new Date(start);var d=parseInt(days);var step=d>0?1:-1;var rem=Math.abs(d);while(rem>0){dt.setDate(dt.getDate()+step);var w=dt.getDay();if(w!==0&&w!==6)rem--;}return dt.toLocaleDateString('en-IN');}
    function __datevalue(d){return Math.round((new Date(d)-new Date(1899,11,30))/86400000);}
    function __timevalue(t){var parts=String(t).split(':');return((parseInt(parts[0])||0)*3600+(parseInt(parts[1])||0)*60+(parseInt(parts[2])||0))/86400;}

    // ── Text helpers (new) ────────────────────────────────────────────────────
    function __search(needle,haystack,start){return String(haystack).toLowerCase().indexOf(String(needle).toLowerCase(),(start||1)-1)+1;}
    function __replace(s,start,nchars,newtext){var str=String(s);return str.substring(0,start-1)+newtext+str.substring(start-1+nchars);}
    function __clean(s){return String(s).replace(/[\x00-\x1F]/g,'');}
    function __fixed(n,d,nocomma){d=d===undefined?2:d;var str=parseFloat(n).toFixed(d);return nocomma?str:str.replace(/\B(?=(\d{3})+(?!\d))/g,',');}
    function __dollar(n,d){d=d===undefined?2:d;return '$'+parseFloat(n).toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g,',');}
    function __textjoin(delim,ignore_empty){var args=[].slice.call(arguments,2).flat();if(ignore_empty)args=args.filter(function(v){return v!==''&&v!==null&&v!==undefined;});return args.join(String(delim));}

    // ── Information helpers ───────────────────────────────────────────────────
    function __iserror(v){return String(v).startsWith('#');}
    function __isna(v){return v==='#N/A';}
    function __islogical(v){return v===true||v===false||v==='TRUE'||v==='FALSE';}
    function __isodd(v){return Math.abs(Math.round(parseFloat(v)))%2===1;}
    function __iseven(v){return Math.abs(Math.round(parseFloat(v)))%2===0;}
    function __isnontext(v){return !isNaN(parseFloat(v))||v===''||v===null||v===undefined;}
    function __n(v){var n=parseFloat(v);return isNaN(n)?0:n;}

    // ── Logical helpers (new) ─────────────────────────────────────────────────
    function __xor(){var a=[].slice.call(arguments);return a.filter(Boolean).length%2===1;}
    function __switch(expr){var args=[].slice.call(arguments,1);for(var i=0;i<args.length-1;i+=2){if(expr==args[i])return args[i+1];}return args.length%2===0?args[args.length-1]:'#N/A';}

    // ── Math helpers (new) ────────────────────────────────────────────────────
    function __sumifs(){
      // Engine flattens: sumRange_vals..., cRange1_vals..., crit1, cRange2_vals..., crit2,...
      var allArgs=[].slice.call(arguments);
      if(allArgs.length<3)return 0;
      // First contiguous block of numbers = sum_range
      var sumVals=[],i=0;
      while(i<allArgs.length){
        var a=String(allArgs[i]).trim();
        var isCrit=a.match(/^(>=|<=|<>|>|<|=)/)||a.indexOf('*')>=0||a.indexOf('?')>=0||(isNaN(parseFloat(a))&&a!=='');
        if(isCrit)break;
        sumVals.push(allArgs[i]);i++;
      }
      var pairs=[];
      while(i<allArgs.length){
        var rangeVals=[];
        while(i<allArgs.length){
          var a=String(allArgs[i]).trim();
          var isCrit=a.match(/^(>=|<=|<>|>|<|=)/)||a.indexOf('*')>=0||a.indexOf('?')>=0||(isNaN(parseFloat(a))&&a!=='');
          if(isCrit)break;
          rangeVals.push(allArgs[i]);i++;
        }
        if(i<allArgs.length&&rangeVals.length){pairs.push({rangeVals:rangeVals,crit:allArgs[i]});i++;}
        else break;
      }
      if(!pairs.length)return 0;
      var s=0;
      for(var idx=0;idx<sumVals.length;idx++){
        var ok=true;
        for(var p=0;p<pairs.length;p++){if(!_matchCrit(pairs[p].rangeVals[idx],pairs[p].crit)){ok=false;break;}}
        if(ok)s+=parseFloat(sumVals[idx])||0;
      }
      return s;
    }
    function __averageifs(){
      var allArgs=[].slice.call(arguments);
      if(allArgs.length<3)return 0;
      var avgVals=[],i=0;
      while(i<allArgs.length){
        var a=String(allArgs[i]).trim();
        var isCrit=a.match(/^(>=|<=|<>|>|<|=)/)||a.indexOf('*')>=0||a.indexOf('?')>=0||(isNaN(parseFloat(a))&&a!=='');
        if(isCrit)break;
        avgVals.push(allArgs[i]);i++;
      }
      var pairs=[];
      while(i<allArgs.length){
        var rangeVals=[];
        while(i<allArgs.length){
          var a=String(allArgs[i]).trim();
          var isCrit=a.match(/^(>=|<=|<>|>|<|=)/)||a.indexOf('*')>=0||a.indexOf('?')>=0||(isNaN(parseFloat(a))&&a!=='');
          if(isCrit)break;
          rangeVals.push(allArgs[i]);i++;
        }
        if(i<allArgs.length&&rangeVals.length){pairs.push({rangeVals:rangeVals,crit:allArgs[i]});i++;}
        else break;
      }
      if(!pairs.length)return 0;
      var s=0,cnt=0;
      for(var idx=0;idx<avgVals.length;idx++){
        var ok=true;
        for(var p=0;p<pairs.length;p++){if(!_matchCrit(pairs[p].rangeVals[idx],pairs[p].crit)){ok=false;break;}}
        if(ok){var n=parseFloat(avgVals[idx]);if(!isNaN(n)){s+=n;cnt++;}}
      }
      return cnt?s/cnt:0;
    }
    function __sign(v){return v>0?1:v<0?-1:0;}
    function __even(v){var n=Math.ceil(Math.abs(parseFloat(v)));return v<0?-(n%2?n+1:n):(n%2?n+1:n);}
    function __odd(v){var n=Math.ceil(Math.abs(parseFloat(v)));var r=n%2?n:n+1;return v<0?-r:r;}
    function __fact(n){if(n<0)return'#NUM!';var r=1;for(var i=2;i<=n;i++)r*=i;return r;}
    function __factdouble(n){var r=1;for(var i=n;i>0;i-=2)r*=i;return r;}
    function __gcd(a,b){a=Math.abs(a);b=Math.abs(b);while(b){var t=b;b=a%b;a=t;}return a;}
    function __lcm(a,b){return Math.abs(a*b)/__gcd(a,b);}
    function __combina(n,k){return __combin(n+k-1,k);}
    function __permuta(n,k){return __permut(n,k);}
    function __randbetween(lo,hi){return Math.floor(Math.random()*(hi-lo+1))+lo;}
    function __mround(n,multiple){return Math.round(n/multiple)*multiple;}
    function __degrees(r){return r*180/Math.PI;}
    function __radians(d){return d*Math.PI/180;}
    function __product(){return[].slice.call(arguments).flat().reduce(function(s,v){var n=parseFloat(v);return isNaN(n)?s:s*n;},1);}
    function __quotient(n,d){return Math.trunc(n/d);}
    function __subtotal(fn_num){var vals=_nums.apply(null,[].slice.call(arguments,1));fn_num=parseInt(fn_num)%100;if(fn_num===1)return _mean(vals);if(fn_num===2)return vals.length;if(fn_num===3)return vals.length;if(fn_num===4)return Math.max.apply(null,vals);if(fn_num===5)return Math.min.apply(null,vals);if(fn_num===9)return vals.reduce(function(s,v){return s+v;},0);if(fn_num===7)return __stdev.apply(null,vals);if(fn_num===8)return __stdevp.apply(null,vals);return vals.reduce(function(s,v){return s+v;},0);}

    // ── Extended Financial helpers ─────────────────────────────────────────────
    function __accrint(issue,first,settle,rate,par,freq){par=par||1000;return par*rate*(Math.abs(new Date(settle)-new Date(issue))/86400000)/365;}
    function __accrintm(issue,settle,rate,par){par=par||1000;return par*rate*(Math.abs(new Date(settle)-new Date(issue))/86400000)/365;}
    function __amordegrc(cost,date_purchased,first_period,salvage,period,rate){return cost*rate;}
    function __amorlinc(cost,date_purchased,first_period,salvage,period,rate){return (cost-salvage)*rate;}
    function __coupdaybs(settle,maturity,freq){return 30;}
    function __coupdays(settle,maturity,freq){return Math.round(365/freq);}
    function __coupdaysnc(settle,maturity,freq){return Math.round(365/freq)-30;}
    function __coupncd(settle,maturity,freq){return maturity;}
    function __coupnum(settle,maturity,freq){freq=freq||2;return Math.ceil((new Date(maturity)-new Date(settle))/86400000/(365/freq));}
    function __couppcd(settle,maturity,freq){return settle;}
    function __cumipmt(rate,nper,pv,start,end,type){var s=0;for(var i=start;i<=end;i++)s+=__ipmt(rate,i,nper,pv,0,type||0);return s;}
    function __cumprinc(rate,nper,pv,start,end,type){var s=0;for(var i=start;i<=end;i++)s+=__ppmt(rate,i,nper,pv,0,type||0);return s;}
    function __ddb(cost,salvage,life,period,factor){factor=factor||2;var rate=factor/life;var val=cost;for(var i=1;i<period;i++)val=val*(1-rate);return Math.min(val*rate,val-salvage);}
    function __disc(settle,maturity,pr,redemption){return (redemption-pr)/redemption*365/(Math.abs(new Date(maturity)-new Date(settle))/86400000);}
    function __dollarde(frac,fraction){var i=Math.floor(frac);return i+(frac-i)*10/fraction;}
    function __dollarfr(dec,fraction){var i=Math.floor(dec);return i+(dec-i)*fraction/10;}
    function __duration(settle,maturity,coupon,yld,freq){freq=freq||2;var n=__coupnum(settle,maturity,freq);var dur=0,pv=0;for(var i=1;i<=n;i++){var cf=coupon/freq*(i<n?1:0)+1;var disc=Math.pow(1+yld/freq,i);dur+=i/freq*cf/disc;pv+=cf/disc;}return dur/pv;}
    function __fvschedule(pv,rates){var v=[].slice.call(rates).flat();return v.reduce(function(s,r){return s*(1+parseFloat(r));},parseFloat(pv));}
    function __intrate(settle,maturity,investment,redemption){return (redemption-investment)/investment*365/(Math.abs(new Date(maturity)-new Date(settle))/86400000);}
    function __ispmt(rate,per,nper,pv){return pv*rate*(1-per/nper);}
    function __mduration(settle,maturity,coupon,yld,freq){return __duration(settle,maturity,coupon,yld,freq)/(1+yld/freq);}
    function __nominal(effect_rate,npery){return npery*(Math.pow(1+effect_rate,1/npery)-1);}
    function __oddfprice(){return 100;}
    function __oddfyield(){return 0.05;}
    function __oddlprice(){return 100;}
    function __oddlyield(){return 0.05;}
    function __pduration(rate,pv,fv){return Math.log(fv/pv)/Math.log(1+rate);}
    function __price(settle,maturity,rate,yld,redemption,freq){freq=freq||2;var n=__coupnum(settle,maturity,freq);var p=redemption/Math.pow(1+yld/freq,n);for(var i=1;i<=n;i++)p+=rate/freq*100/Math.pow(1+yld/freq,i);return p;}
    function __pricedisc(settle,maturity,discount,redemption){return redemption-discount*redemption*(Math.abs(new Date(maturity)-new Date(settle))/86400000)/360;}
    function __pricemat(settle,maturity,issue,rate,yld){return (1+rate*(Math.abs(new Date(maturity)-new Date(issue))/86400000)/360)/(1+yld*(Math.abs(new Date(maturity)-new Date(settle))/86400000)/360)*100;}
    function __received(settle,maturity,investment,discount){return investment/(1-discount*(Math.abs(new Date(maturity)-new Date(settle))/86400000)/360);}
    function __rri(nper,pv,fv){return Math.pow(fv/pv,1/nper)-1;}
    function __syd(cost,salvage,life,period){return (cost-salvage)*(life-period+1)*2/(life*(life+1));}
    function __tbilleq(settle,maturity,discount){var days=Math.abs(new Date(maturity)-new Date(settle))/86400000;return 365*discount/(360-discount*days);}
    function __tbillprice(settle,maturity,discount){var days=Math.abs(new Date(maturity)-new Date(settle))/86400000;return 100*(1-discount*days/360);}
    function __tbillyield(settle,maturity,pr){var days=Math.abs(new Date(maturity)-new Date(settle))/86400000;return (100-pr)/pr*365/days;}
    function __vdb(cost,salvage,life,start,end,factor){factor=factor||2;var s=0;for(var i=Math.floor(start);i<Math.ceil(end);i++){var rem=cost-s-salvage;s+=Math.min(rem*factor/life,rem);}return s;}
    function __yield(settle,maturity,rate,pr,redemption,freq){freq=freq||2;var n=__coupnum(settle,maturity,freq);var y=rate;for(var i=0;i<100;i++){var p=__price(settle,maturity,rate,y,redemption,freq);var dp=(p-pr);if(Math.abs(dp)<0.0001)return y;y+=dp/100/n;}return y;}
    function __yielddisc(settle,maturity,pr,redemption){var days=Math.abs(new Date(maturity)-new Date(settle))/86400000;return (redemption-pr)/pr*365/days;}
    function __yieldmat(settle,maturity,issue,rate,pr){return (1+rate*(Math.abs(new Date(maturity)-new Date(issue))/86400000)/360)/(pr/100+(rate*(Math.abs(new Date(settle)-new Date(issue))/86400000)/360))-1;}

    // ── Extended Date & Time helpers ───────────────────────────────────────────
    function __days360(start,end,method){var s=new Date(start),e=new Date(end);var sm=s.getMonth(),sd=s.getDate(),em=e.getMonth(),ed=e.getDate();if(method){if(sd===31)sd=30;if(ed===31)ed=30;}else{if(sd===31)sd=30;if(ed===31&&sd===30)ed=30;}return (e.getFullYear()-s.getFullYear())*360+(em-sm)*30+(ed-sd);}
    function __networkdaysintl(start,end,weekend,holidays){weekend=weekend||1;var s=new Date(start),e=new Date(end),n=0;var wknd=typeof weekend==='string'?weekend:'0000011';while(s<=e){var d=s.getDay();if(wknd[d==='0'?6:d-1]!=='1')n++;s.setDate(s.getDate()+1);}return n;}
    function __workdayintl(start,days,weekend){weekend=weekend||1;var dt=new Date(start),d=parseInt(days),step=d>0?1:-1,rem=Math.abs(d);while(rem>0){dt.setDate(dt.getDate()+step);var w=dt.getDay();if(w!==0&&w!==6)rem--;}return dt.toLocaleDateString('en-IN');}
    function __yearfrac(start,end,basis){basis=basis||0;var s=new Date(start),e=new Date(end);var days=Math.abs(e-s)/86400000;if(basis===0)return __days360(start,end)/360;if(basis===1)return days/(s.getFullYear()%4===0?366:365);if(basis===2)return days/360;if(basis===3)return days/365;if(basis===4)return __days360(start,end,true)/360;return days/365;}

    // ── Extended Text helpers ──────────────────────────────────────────────────
    function __arraytotext(v){return String(v);}
    function __asc(s){return String(s);}
    function __bahttext(n){return String(n)+' Baht';}
    function __dbcs(s){return String(s);}
    function __encodeurl(s){return encodeURIComponent(String(s));}
    function __formulatext(v){return String(v);}
    function __numberstring(n,type){return String(n);}
    function __percentof(v,total){return total?parseFloat(v)/parseFloat(total):0;}
    function __textafter(text,delim,n){n=n||1;var parts=String(text).split(String(delim));return parts.slice(n).join(String(delim))||'#N/A';}
    function __textbefore(text,delim,n){n=n||1;var parts=String(text).split(String(delim));return parts.slice(0,n).join(String(delim))||'#N/A';}
    function __textsplit(text,col_delim,row_delim){return String(text).split(String(col_delim)).join(',');}
    function __ttext(v){return isNaN(parseFloat(v))&&v!==''?String(v):'';}

    // ── Extended Logical helpers ───────────────────────────────────────────────
    function __ifna(v,na_val){return v==='#N/A'||v==null?na_val:v;}
    function __let(){var args=[].slice.call(arguments);return args[args.length-1];}
    function __lambda(){return '#LAMBDA';}
    function __bycol(){return '#BYCOL';}
    function __byrow(){return '#BYROW';}
    function __makearray(){return '#MAKEARRAY';}
    function __map(){return '#MAP';}
    function __reduce(){return '#REDUCE';}
    function __scan(){return '#SCAN';}

    // ── Extended Lookup helpers ────────────────────────────────────────────────
    function __address(row,col,abs,a1,sheet){var c=colName(col-1);var r=row;if(abs===1||abs===undefined)return '$'+c+'$'+r;if(abs===2)return c+'$'+r;if(abs===3)return '$'+c+r;return c+String(r);}
    function __areas(){return 1;}
    function __choosecols(){var args=[].slice.call(arguments);return args[0];}
    function __chooserows(){var args=[].slice.call(arguments);return args[0];}
    function __column(){return selC+1;}
    function __columns(){return COLS;}
    function __drop(){var args=[].slice.call(arguments);return args[0];}
    function __expand(){var args=[].slice.call(arguments);return args[0];}
    function __filter(){var args=[].slice.call(arguments);return args[0];}
    function __hstack(){return[].slice.call(arguments).flat().join(',');}
    function __offset(ref,rows,cols){return ref;}
    function __row(){return selR+1;}
    function __rows(){return ROWS;}
    function __sort(){var a=[].slice.call(arguments).flat();return a.sort().join(',');}
    function __sortby(){var args=[].slice.call(arguments);return args[0];}
    function __take(){var args=[].slice.call(arguments);return args[0];}
    function __tocol(){return[].slice.call(arguments).flat().join(',');}
    function __torow(){return[].slice.call(arguments).flat().join(',');}
    function __transpose(){return[].slice.call(arguments).flat().join(',');}
    function __unique(){var a=[].slice.call(arguments).flat();return[...new Set(a)].join(',');}
    function __vstack(){return[].slice.call(arguments).flat().join(',');}
    function __xlookup(val,lookup,ret,notfound){var lv=[].slice.call(lookup).flat();var rv=[].slice.call(ret).flat();var idx=lv.findIndex(function(v){return String(v)===String(val);});return idx>=0?rv[idx]:(notfound!==undefined?notfound:'#N/A');}
    function __xmatch(val,arr){var a=[].slice.call(arr).flat();var idx=a.findIndex(function(v){return String(v)===String(val);});return idx>=0?idx+1:'#N/A';}
    function __wrapcols(){return[].slice.call(arguments).flat().join(',');}
    function __wraprows(){return[].slice.call(arguments).flat().join(',');}

    // ── Extended Math & Trig helpers ───────────────────────────────────────────
    function __acot(x){return Math.PI/2-Math.atan(x);}
    function __acoth(x){return 0.5*Math.log((x+1)/(x-1));}
    function __cot(x){return Math.cos(x)/Math.sin(x);}
    function __coth(x){return Math.cosh(x)/Math.sinh(x);}
    function __csc(x){return 1/Math.sin(x);}
    function __csch(x){return 1/Math.sinh(x);}
    function __sec(x){return 1/Math.cos(x);}
    function __sech(x){return 1/Math.cosh(x);}
    function __sqrtpi(x){return Math.sqrt(parseFloat(x)*Math.PI);}
    function __sumsq(){return[].slice.call(arguments).flat().reduce(function(s,v){var n=parseFloat(v);return isNaN(n)?s:s+n*n;},0);}
    function __sumx2my2(){var a=[].slice.call(arguments).flat(),n=Math.floor(a.length/2),x=a.slice(0,n),y=a.slice(n);return x.reduce(function(s,xi,i){return s+xi*xi-y[i]*y[i];},0);}
    function __sumx2py2(){var a=[].slice.call(arguments).flat(),n=Math.floor(a.length/2),x=a.slice(0,n),y=a.slice(n);return x.reduce(function(s,xi,i){return s+xi*xi+y[i]*y[i];},0);}
    function __mdeterm(arr){var a=[].slice.call(arr).flat();var n=Math.round(Math.sqrt(a.length));if(n*n!==a.length)return'#VALUE!';if(n===1)return a[0];if(n===2)return a[0]*a[3]-a[1]*a[2];return'#N/A';}
    function __mmult(){return[].slice.call(arguments).flat().reduce(function(s,v){return s+(parseFloat(v)||0);},0);}
    function __minverse(){return'#N/A';}
    function __multinomial(){var a=[].slice.call(arguments).flat().map(Number);var sum=a.reduce(function(s,v){return s+v;},0);var num=Math.exp(_gammaln(sum+1));var den=a.reduce(function(s,v){return s*Math.exp(_gammaln(v+1));},1);return num/den;}
    function __seriessum(x,n,m,coeffs){var c=[].slice.call(coeffs).flat();return c.reduce(function(s,a,i){return s+a*Math.pow(x,n+i*m);},0);}
    function __sequence(rows,cols,start,step){rows=rows||1;cols=cols||1;start=start||1;step=step||1;var r=[];for(var i=0;i<rows*cols;i++)r.push(start+i*step);return r.join(',');}
    function __randarray(rows,cols){rows=rows||1;cols=cols||1;var r=[];for(var i=0;i<rows*cols;i++)r.push(Math.random().toFixed(4));return r.join(',');}
    function __roundbank(v,d){d=d||0;var f=Math.pow(10,d);var n=parseFloat(v)*f;var fl=Math.floor(n);return(n-fl===0.5?(fl%2===0?fl:fl+1):Math.round(n))/f;}
    function __base(n,radix,minLen){var r=parseInt(n).toString(parseInt(radix)).toUpperCase();return minLen?r.padStart(minLen,'0'):r;}
    function __decimal(text,radix){return parseInt(String(text),parseInt(radix));}
    function __arabic(text){var s=String(text).toUpperCase();var map={M:1000,D:500,C:100,L:50,X:10,V:5,I:1};var r=0;for(var i=0;i<s.length;i++){var c=map[s[i]]||0;var n=map[s[i+1]]||0;r+=c<n?-c:c;}return r;}
    function __roman(n){var vals=[1000,900,500,400,100,90,50,40,10,9,5,4,1];var syms=['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];var r='';vals.forEach(function(v,i){while(n>=v){r+=syms[i];n-=v;}});return r;}
    function __maxifs(){var args=[].slice.call(arguments);var maxRange=args[0];if(!Array.isArray(maxRange))maxRange=[maxRange];var best=-Infinity;maxRange.forEach(function(v,i){var ok=true;for(var j=1;j<args.length-1;j+=2){var range=Array.isArray(args[j])?args[j]:[args[j]];if(String(range[i]||'')!==String(args[j+1]||''))ok=false;}if(ok){var n=parseFloat(v);if(!isNaN(n)&&n>best)best=n;}});return best===-Infinity?0:best;}
    function __minifs(){var args=[].slice.call(arguments);var minRange=args[0];if(!Array.isArray(minRange))minRange=[minRange];var best=Infinity;minRange.forEach(function(v,i){var ok=true;for(var j=1;j<args.length-1;j+=2){var range=Array.isArray(args[j])?args[j]:[args[j]];if(String(range[i]||'')!==String(args[j+1]||''))ok=false;}if(ok){var n=parseFloat(v);if(!isNaN(n)&&n<best)best=n;}});return best===Infinity?0:best;}
    function __aggregate(fn_num){return __subtotal.apply(null,arguments);}

    // ── Extended Information helpers ───────────────────────────────────────────
    function __iserr(v){return String(v).startsWith('#')&&v!=='#N/A';}
    function __isformula(v){return String(v).startsWith('=');}
    function __isomitted(v){return v===undefined||v===null;}
    function __isref(v){return parseRef(String(v))!==null;}
    function __phonetic(v){return String(v);}
    function __sheetscount(){return typeof sheets!=='undefined'?sheets.length:1;}
    function __type(v){if(v===true||v===false)return 4;if(Array.isArray(v))return 64;if(String(v).startsWith('#'))return 16;if(!isNaN(parseFloat(v)))return 1;return 2;}
    function __info(type){if(type==='version')return'1.0';if(type==='system')return'win32';return'';}

    // ── Engineering helpers ────────────────────────────────────────────────────
    // Number base conversions
    function __bin2dec(v){return parseInt(String(v),2);}
    function __bin2hex(v,p){return parseInt(String(v),2).toString(16).toUpperCase().padStart(p||1,'0');}
    function __bin2oct(v,p){return parseInt(String(v),2).toString(8).padStart(p||1,'0');}
    function __dec2bin(v,p){return (parseInt(v)>>>0).toString(2).padStart(p||1,'0');}
    function __dec2hex(v,p){return parseInt(v).toString(16).toUpperCase().padStart(p||1,'0');}
    function __dec2oct(v,p){return parseInt(v).toString(8).padStart(p||1,'0');}
    function __hex2bin(v,p){return parseInt(String(v),16).toString(2).padStart(p||1,'0');}
    function __hex2dec(v){return parseInt(String(v),16);}
    function __hex2oct(v,p){return parseInt(String(v),16).toString(8).padStart(p||1,'0');}
    function __oct2bin(v,p){return parseInt(String(v),8).toString(2).padStart(p||1,'0');}
    function __oct2dec(v){return parseInt(String(v),8);}
    function __oct2hex(v,p){return parseInt(String(v),8).toString(16).toUpperCase().padStart(p||1,'0');}
    // Bitwise
    function __bitand(a,b){return parseInt(a)&parseInt(b);}
    function __bitor(a,b){return parseInt(a)|parseInt(b);}
    function __bitxor(a,b){return parseInt(a)^parseInt(b);}
    function __bitlshift(n,s){return parseInt(n)<<parseInt(s);}
    function __bitrshift(n,s){return parseInt(n)>>parseInt(s);}
    // Misc engineering
    function __delta(a,b){return parseFloat(a)===(b===undefined?0:parseFloat(b))?1:0;}
    function __gestep(n,step){return parseFloat(n)>=(step===undefined?0:parseFloat(step))?1:0;}
    function __erf2(x){return _erf(parseFloat(x));}
    function __erfc(x){return 1-_erf(parseFloat(x));}
    // Convert units (common subset)
    var _convFactors={kg:1,g:0.001,lbm:0.453592,ozm:0.0283495,m:1,km:1000,mi:1609.34,ft:0.3048,inch:0.0254,cm:0.01,mm:0.001,l:0.001,ml:0.000001,tsp:0.00000492892,J:1,kJ:1000,cal:4.18400,kWh:3600000,Pa:1,atm:101325,C:1};
    function __convert(n,from,to){var f=_convFactors[from],t=_convFactors[to];return(f&&t)?parseFloat(n)*f/t:'#N/A';}
    // Bessel functions (simplified approximations)
    function __besseli(x,n){x=parseFloat(x);n=parseInt(n);var s=0;for(var k=0;k<20;k++){var term=Math.pow(x/2,2*k+n)/(Math.exp(_gammaln(k+1))*Math.exp(_gammaln(k+n+1)));s+=term;}return s;}
    function __besselj(x,n){x=parseFloat(x);n=parseInt(n);var s=0;for(var k=0;k<20;k++){var term=Math.pow(-1,k)*Math.pow(x/2,2*k+n)/(Math.exp(_gammaln(k+1))*Math.exp(_gammaln(k+n+1)));s+=term;}return s;}
    function __besselk(x,n){return Math.PI/2*(__besseli(-x,n)-__besseli(x,n));}
    function __bessely(x,n){return(__besselj(x,n)*Math.cos(n*Math.PI)-__besselj(x,-n))/Math.sin(n*Math.PI);}
    // Complex number helpers (stored as "a+bi" string)
    function _parseComplex(s){s=String(s).replace(/\s/g,'');var m=s.match(/^([+-]?[\d.]+)?([+-][\d.]+)?i?$|^([+-]?[\d.]+)?([+-]?[\d.]*)?i$/);var re=parseFloat(s.replace(/([+-][\d.]*i|i)/g,''))||0;var imStr=s.match(/([+-]?[\d.]*)i/);var im=imStr?(imStr[1]===''||imStr[1]==='+'?1:imStr[1]==='-'?-1:parseFloat(imStr[1])):0;return{re:re,im:im};}
    function _fmtComplex(re,im){if(im===0)return String(re);if(re===0)return im+'i';return re+(im>=0?'+':'')+im+'i';}
    function __complex(re,im,suffix){return _fmtComplex(parseFloat(re),parseFloat(im));}
    function __imabs(c){var p=_parseComplex(c);return Math.sqrt(p.re*p.re+p.im*p.im);}
    function __imaginary(c){return _parseComplex(c).im;}
    function __imreal(c){return _parseComplex(c).re;}
    function __imargument(c){var p=_parseComplex(c);return Math.atan2(p.im,p.re);}
    function __imconjugate(c){var p=_parseComplex(c);return _fmtComplex(p.re,-p.im);}
    function __imadd(c1,c2){var a=_parseComplex(c1),b=_parseComplex(c2);return _fmtComplex(a.re+b.re,a.im+b.im);}
    function __imsum(){var args=[].slice.call(arguments).flat();return args.reduce(function(s,c){return __imadd(s,c);},'0');}
    function __imsub(c1,c2){var a=_parseComplex(c1),b=_parseComplex(c2);return _fmtComplex(a.re-b.re,a.im-b.im);}
    function __improduct(){var args=[].slice.call(arguments).flat();return args.reduce(function(s,c){var a=_parseComplex(s),b=_parseComplex(c);return _fmtComplex(a.re*b.re-a.im*b.im,a.re*b.im+a.im*b.re);});}
    function __imdiv(c1,c2){var a=_parseComplex(c1),b=_parseComplex(c2);var d=b.re*b.re+b.im*b.im;return _fmtComplex((a.re*b.re+a.im*b.im)/d,(a.im*b.re-a.re*b.im)/d);}
    function __impower(c,n){var p=_parseComplex(c),r=Math.pow(__imabs(c),n),theta=Math.atan2(p.im,p.re)*n;return _fmtComplex(r*Math.cos(theta),r*Math.sin(theta));}
    function __imsqrt(c){return __impower(c,0.5);}
    function __imexp(c){var p=_parseComplex(c),er=Math.exp(p.re);return _fmtComplex(er*Math.cos(p.im),er*Math.sin(p.im));}
    function __imln(c){var p=_parseComplex(c);return _fmtComplex(Math.log(__imabs(c)),Math.atan2(p.im,p.re));}
    function __imlog10(c){var l=_parseComplex(__imln(c));return _fmtComplex(l.re/Math.LN10,l.im/Math.LN10);}
    function __imlog2(c){var l=_parseComplex(__imln(c));return _fmtComplex(l.re/Math.LN2,l.im/Math.LN2);}
    function __imsin(c){var p=_parseComplex(c);return _fmtComplex(Math.sin(p.re)*Math.cosh(p.im),Math.cos(p.re)*Math.sinh(p.im));}
    function __imcos(c){var p=_parseComplex(c);return _fmtComplex(Math.cos(p.re)*Math.cosh(p.im),-Math.sin(p.re)*Math.sinh(p.im));}
    function __imtan(c){return __imdiv(__imsin(c),__imcos(c));}
    function __imsinh(c){var p=_parseComplex(c);return _fmtComplex(Math.sinh(p.re)*Math.cos(p.im),Math.cosh(p.re)*Math.sin(p.im));}
    function __imcosh(c){var p=_parseComplex(c);return _fmtComplex(Math.cosh(p.re)*Math.cos(p.im),Math.sinh(p.re)*Math.sin(p.im));}
    function __imcot(c){return __imdiv(__imcos(c),__imsin(c));}
    function __imcsc(c){return __imdiv('1',__imsin(c));}
    function __imcsch(c){return __imdiv('1',__imsinh(c));}
    function __imsec(c){return __imdiv('1',__imcos(c));}
    function __imsech(c){return __imdiv('1',__imcosh(c));}
    function __oct2bin(v,p){return parseInt(String(v),8).toString(2).padStart(p||1,'0');}
    function __oct2hex(v,p){return parseInt(String(v),8).toString(16).toUpperCase().padStart(p||1,'0');}
    // Bessel stubs already defined above
    return eval(expr);
  }catch(e){return'#ERR';}
}

function formatVal(val,r,c){
  var f=cellFmt[cellId(r,c)]||'',n=parseFloat(val);
  if(f==='currency'&&!isNaN(n))return'₹'+n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
  if(f==='usd'&&!isNaN(n))return'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  if(f==='percent'&&!isNaN(n))return(n*100).toFixed(1)+'%';
  if(f==='number'&&!isNaN(n))return n.toFixed(2);
  if(f==='integer'&&!isNaN(n))return Math.round(n).toString();
  if(f==='sci'&&!isNaN(n))return n.toExponential(2);
  if(f==='date'&&!isNaN(n))return new Date((n-25569)*86400000).toLocaleDateString('en-IN');
  if(f==='time')return val;
  if(!isNaN(n)&&val!=='')return n%1===0?n:parseFloat(n.toFixed(8));
  return val;
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderCell(r,c){
  var el=document.getElementById('d-'+r+'-'+c);
  if(!el||el.querySelector('input'))return;
  var raw=getRaw(r,c),disp=raw,isNum=false,isErr=false;
  if(raw&&raw.startsWith('=')){
    var v=evalFormula(raw);
    disp=formatVal(v,r,c);isErr=String(v).startsWith('#');isNum=!isErr&&!isNaN(parseFloat(v));
  }else if(raw!==''){disp=formatVal(raw,r,c);isNum=!isNaN(parseFloat(raw));}
  el.textContent=disp;
  var s=cellStyle[cellId(r,c)]||{};
  var cls='cd'+(isNum&&!s.align?' num':'')+(isErr?' err':'');
  el.className=cls;
  var css='';
  if(s.bold)css+='font-weight:bold;';
  if(s.italic)css+='font-style:italic;';
  if(s.underline)css+='text-decoration:underline;';
  if(s.strike)css+='text-decoration:line-through;';
  if(s.align)css+='text-align:'+s.align+';';
  else if(isNum)css+='text-align:right;';
  if(s.fontFamily)css+='font-family:'+s.fontFamily+';';
  if(s.fontSize)css+='font-size:'+s.fontSize+'px;';
  if(s.color)css+='color:'+s.color+';';
  if(s.wrap)css+='white-space:normal;line-height:1.4;height:auto;overflow:visible;'
  if(s.indent)css+='padding-left:'+((s.indent*12)+4)+'px;';
  if(s.orientation)css+=s.orientation+';';;
  el.style.cssText=css;
  var cell=document.getElementById('c-'+r+'-'+c);
  if(cell){
    if(s.bg)cell.style.background=s.bg;
    else if(!cell.classList.contains('tbl-h')&&!cell.classList.contains('tbl-a'))cell.style.background='';
    // Apply per-cell borders to the TD (override grid lines)
    cell.style.borderTop   =s.bt||'';
    cell.style.borderBottom=s.bb||'';
    cell.style.borderLeft  =s.bl||'';
    cell.style.borderRight =s.br||'';
    // Vertical alignment
    cell.style.verticalAlign=s.valign||'middle';
  }
  // Comment indicator
  var existingDot=cell&&cell.querySelector('.cell-comment');
  if(cellComments[cellId(r,c)]){
    if(!existingDot&&cell){var dot=document.createElement('div');dot.className='cell-comment';cell.appendChild(dot);}
  }else{if(existingDot)existingDot.remove();}
}
function renderAll(){for(var r=0;r<ROWS;r++)for(var c=0;c<COLS;c++)renderCell(r,c);}

// ── Grid Build ────────────────────────────────────────────────────────────────
function buildGrid(){
  var table=document.getElementById('grid');
  table.innerHTML='';
  var thead=document.createElement('thead');
  var hr=document.createElement('tr');
  var corner=document.createElement('th');corner.className='ch rh';corner.style.width='52px';corner.style.minWidth='52px';hr.appendChild(corner);
  for(var c=0;c<COLS;c++){
    var th=document.createElement('th');th.className='ch';th.id='ch-'+c;
    var w=colWidths[c]||82;th.style.width=w+'px';th.style.minWidth=w+'px';th.style.position='relative';
    th.innerHTML='<span style="pointer-events:none">'+colName(c)+'</span>';
    th.addEventListener('mousedown',function(e){
      if(editMode&&_activeInp&&_activeInp.value.startsWith('='))e.preventDefault();
    });
    (function(cc){var rz=document.createElement('div');rz.style.cssText='position:absolute;right:0;top:0;width:4px;height:100%;cursor:col-resize;z-index:5;';rz.addEventListener('mousedown',function(e){startColResize(e,cc);});th.appendChild(rz);})(c);
    hr.appendChild(th);
  }
  thead.appendChild(hr);table.appendChild(thead);
  var tbody=document.createElement('tbody');
  for(var r=0;r<ROWS;r++){
    var tr=document.createElement('tr');tr.id='tr-'+r;var rh2=rowHeights[r]||22;tr.style.height=rh2+'px';
    var rh=document.createElement('th');rh.className='ch rh';rh.id='rh-'+r;rh.style.position='relative';rh.style.width='52px';rh.style.minWidth='52px';
    rh.innerHTML='<span style="pointer-events:none">'+(r+1)+'</span>';
    rh.addEventListener('mousedown',function(e){
      if(editMode&&_activeInp&&_activeInp.value.startsWith('='))e.preventDefault();
    });
    (function(rr){var rdh=document.createElement('div');rdh.style.cssText='position:absolute;bottom:0;left:0;width:100%;height:3px;cursor:row-resize;z-index:5;';rdh.addEventListener('mousedown',function(e){startRowResize(e,rr);});rh.appendChild(rdh);})(r);
    tr.appendChild(rh);
    for(var c=0;c<COLS;c++){
      var td=document.createElement('td');td.className='dc';td.id='c-'+r+'-'+c;td.style.height=rh2+'px';
      var dv=document.createElement('div');dv.className='cd';dv.id='d-'+r+'-'+c;td.appendChild(dv);
      (function(rr,cc){
        td.addEventListener('mousedown',function(e){
          if(e.button!==0)return;
          // If currently editing a formula, clicking a cell inserts its reference
          if(editMode && _activeInp && _activeInp.value.startsWith('=')){
            e.preventDefault();
            e.stopPropagation();
            // Track drag start for formula range selection (separate from normal rangeStart)
            _formulaSel = {r:rr, c:cc};
            var ref = cellId(rr,cc);
            var cur = _activeInp.value;
            // Replace trailing partial cell ref after operator/paren
            var newVal = cur.replace(/([,(+\-*/^(])[A-Z]{0,2}\d*$/, function(m, op){ return op + ref; });
            if(newVal === cur) newVal = cur.replace(/[A-Z]{0,2}\d*$/, ref);
            _activeInp.value = newVal;
            _activeInp.focus();
            _activeInp.setSelectionRange(newVal.length, newVal.length);
            document.getElementById('formula-input').value = newVal;
            // Show blue dashed outline on the single clicked cell only
            clearFormulaSel();
            showFormulaSel(rr, cc, rr, cc);
            return;
          }
          // During formula edit, clicks on cells insert cell refs — never call startSel
          if(editMode && _activeInp && _activeInp.value.startsWith('=')) {
            e.preventDefault(); // prevents input blur which would commit the formula
            return;
          }
          _resizingCol=-1;_resizingRow=-1;commitEdit();startSel(rr,cc,e);
        });
        td.addEventListener('mouseup',function(e){
          // On mouseup during formula drag, finalize the range ref
          if(editMode && _activeInp && _activeInp.value.startsWith('=') && _formulaSel){
            var r1=Math.min(_formulaSel.r, _formulaSelEnd?_formulaSelEnd.r:_formulaSel.r);
            var r2=Math.max(_formulaSel.r, _formulaSelEnd?_formulaSelEnd.r:_formulaSel.r);
            var c1=Math.min(_formulaSel.c, _formulaSelEnd?_formulaSelEnd.c:_formulaSel.c);
            var c2=Math.max(_formulaSel.c, _formulaSelEnd?_formulaSelEnd.c:_formulaSel.c);
            if(r1!==r2||c1!==c2){
              var ref=cellId(r1,c1)+':'+cellId(r2,c2);
              var cur=_activeInp.value;
              var newVal=cur.replace(/[A-Z]+\d+(:[A-Z]+\d+)?$/, ref);
              _activeInp.value=newVal;
              document.getElementById('formula-input').value=newVal;
              _activeInp.focus();
            }
            _formulaSelEnd = null;
          }
        });
        td.addEventListener('mouseover',function(e){
          // Formula drag is handled by document mousemove — never allow extSel during formula edit
          if(editMode && _activeInp && _activeInp.value.startsWith('=')) return;
          extSel(rr,cc,e);
        });
        td.addEventListener('contextmenu',function(e){showCtx(e,rr,cc);});
        td.addEventListener('dblclick',function(){startInlineEdit(rr,cc);});
        td.addEventListener('mouseover',function(){showCommentTip(rr,cc);});
        td.addEventListener('mouseleave',function(){hideCommentTip();});
      })(r,c);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  populateSortCols();
  // Force explicit table width so Electron renders all columns
  var totalW = 52 + (COLS * 82);
  table.style.width = totalW + 'px';

  // Prevent native drag on grid — stops scroll jump during formula cell selection
  table.addEventListener('dragstart', function(e){ e.preventDefault(); });
  var gc = document.getElementById('grid-container');
  gc.addEventListener('dragstart', function(e){ e.preventDefault(); });
  // Prevent any mousedown on grid-container from stealing focus during formula edit
  gc.addEventListener('mousedown', function(e){
    if(editMode&&_activeInp&&_activeInp.value.startsWith('=')) e.preventDefault();
  });

  // All rows are built immediately — no reveal loop needed
}

// ── Inline Edit core ─────────────────────────────────────────────────────────
function commitEdit(){
  if(!editMode||!_activeInp)return;
  var v=_activeInp.value,r=_activeR,c=_activeC;
  editMode=false;
  var dv=document.getElementById('d-'+r+'-'+c);
  if(dv&&_activeInp.parentNode===dv)dv.removeChild(_activeInp);
  _activeInp=null;_activeR=-1;_activeC=-1;
  resetFormulaSel();
  setRaw(r,c,v);
  document.getElementById('formula-input').value=v;
}
function cancelEdit(){
  if(!editMode||!_activeInp)return;
  var r=_activeR,c=_activeC;
  editMode=false;
  var dv=document.getElementById('d-'+r+'-'+c);
  if(dv&&_activeInp.parentNode===dv)dv.removeChild(_activeInp);
  _activeInp=null;_activeR=-1;_activeC=-1;
  resetFormulaSel();
  renderCell(r,c);
}

// ── Formula Autocomplete ──────────────────────────────────────────────────────
var FORMULA_LIST = [
  {name:'SUM',sig:'SUM(number1, [number2], ...)',desc:'Adds all numbers in a range.'},
  {name:'AVERAGE',sig:'AVERAGE(number1, [number2], ...)',desc:'Returns the average of numbers.'},
  {name:'COUNT',sig:'COUNT(value1, [value2], ...)',desc:'Counts cells that contain numbers.'},
  {name:'COUNTA',sig:'COUNTA(value1, [value2], ...)',desc:'Counts non-empty cells.'},
  {name:'MAX',sig:'MAX(number1, [number2], ...)',desc:'Returns the largest value.'},
  {name:'MIN',sig:'MIN(number1, [number2], ...)',desc:'Returns the smallest value.'},
  {name:'IF',sig:'IF(logical_test, value_if_true, value_if_false)',desc:'Returns one value if true, another if false.'},
  {name:'IFS',sig:'IFS(test1, value1, [test2, value2], ...)',desc:'Checks multiple conditions in order.'},
  {name:'VLOOKUP',sig:'VLOOKUP(lookup_value, table_array, col_index, [range_lookup])',desc:'Looks up a value in the first column of a range.'},
  {name:'HLOOKUP',sig:'HLOOKUP(lookup_value, table_array, row_index, [range_lookup])',desc:'Looks up a value in the first row of a range.'},
  {name:'INDEX',sig:'INDEX(array, row_num, [col_num])',desc:'Returns value at given row/col in range.'},
  {name:'MATCH',sig:'MATCH(lookup_value, lookup_array, [match_type])',desc:'Returns the position of a value in a range.'},
  {name:'IFERROR',sig:'IFERROR(value, value_if_error)',desc:'Returns value_if_error if value is an error.'},
  {name:'COUNTIF',sig:'COUNTIF(range, criteria)',desc:'Counts cells that meet a condition.'},
  {name:'SUMIF',sig:'SUMIF(range, criteria, [sum_range])',desc:'Sums cells that meet a condition.'},
  {name:'AVERAGEIF',sig:'AVERAGEIF(range, criteria)',desc:'Averages cells meeting a condition.'},
  {name:'ROUND',sig:'ROUND(number, num_digits)',desc:'Rounds a number to specified digits.'},
  {name:'ROUNDUP',sig:'ROUNDUP(number, num_digits)',desc:'Rounds up away from zero.'},
  {name:'ROUNDDOWN',sig:'ROUNDDOWN(number, num_digits)',desc:'Rounds down toward zero.'},
  {name:'ABS',sig:'ABS(number)',desc:'Returns the absolute value.'},
  {name:'SQRT',sig:'SQRT(number)',desc:'Returns the square root.'},
  {name:'POWER',sig:'POWER(number, power)',desc:'Returns number raised to a power.'},
  {name:'MOD',sig:'MOD(number, divisor)',desc:'Returns the remainder after division.'},
  {name:'INT',sig:'INT(number)',desc:'Rounds down to the nearest integer.'},
  {name:'LEN',sig:'LEN(text)',desc:'Returns the length of a string.'},
  {name:'LEFT',sig:'LEFT(text, [num_chars])',desc:'Returns leftmost characters.'},
  {name:'RIGHT',sig:'RIGHT(text, [num_chars])',desc:'Returns rightmost characters.'},
  {name:'MID',sig:'MID(text, start_num, num_chars)',desc:'Returns characters from the middle.'},
  {name:'UPPER',sig:'UPPER(text)',desc:'Converts text to uppercase.'},
  {name:'LOWER',sig:'LOWER(text)',desc:'Converts text to lowercase.'},
  {name:'TRIM',sig:'TRIM(text)',desc:'Removes extra spaces from text.'},
  {name:'PROPER',sig:'PROPER(text)',desc:'Capitalises first letter of each word.'},
  {name:'CONCAT',sig:'CONCAT(text1, [text2], ...)',desc:'Joins text strings together.'},
  {name:'FIND',sig:'FIND(find_text, within_text, [start_num])',desc:'Finds position of text (case-sensitive).'},
  {name:'SUBSTITUTE',sig:'SUBSTITUTE(text, old_text, new_text)',desc:'Replaces occurrences of a string.'},
  {name:'TEXT',sig:'TEXT(value, format_text)',desc:'Formats a number as text.'},
  {name:'VALUE',sig:'VALUE(text)',desc:'Converts text to a number.'},
  {name:'TODAY',sig:'TODAY()',desc:'Returns today\'s date.'},
  {name:'NOW',sig:'NOW()',desc:'Returns current date and time.'},
  {name:'DATE',sig:'DATE(year, month, day)',desc:'Returns a date from year, month, day.'},
  {name:'YEAR',sig:'YEAR(date)',desc:'Returns the year of a date.'},
  {name:'MONTH',sig:'MONTH(date)',desc:'Returns the month of a date.'},
  {name:'DAY',sig:'DAY(date)',desc:'Returns the day of a date.'},
  {name:'PMT',sig:'PMT(rate, nper, pv)',desc:'Returns loan payment amount.'},
  {name:'NPV',sig:'NPV(rate, value1, [value2], ...)',desc:'Net present value of cash flows.'},
  {name:'AND',sig:'AND(logical1, [logical2], ...)',desc:'Returns TRUE if all arguments are true.'},
  {name:'OR',sig:'OR(logical1, [logical2], ...)',desc:'Returns TRUE if any argument is true.'},
  {name:'NOT',sig:'NOT(logical)',desc:'Reverses the logic of its argument.'},
  {name:'ISBLANK',sig:'ISBLANK(value)',desc:'Returns TRUE if cell is empty.'},
  {name:'ISNUMBER',sig:'ISNUMBER(value)',desc:'Returns TRUE if value is a number.'},
  {name:'ISTEXT',sig:'ISTEXT(value)',desc:'Returns TRUE if value is text.'},
  // ── Statistical ──────────────────────────────────────────────────────────
  {name:'MEDIAN',sig:'MEDIAN(number1, [number2], ...)',desc:'Returns the median of a set of numbers.'},
  {name:'MODE',sig:'MODE(number1, [number2], ...)',desc:'Returns the most common value.'},
  {name:'MODE.MULT',sig:'MODE.MULT(number1, [number2], ...)',desc:'Returns multiple modes.'},
  {name:'STDEV',sig:'STDEV(number1, [number2], ...)',desc:'Sample standard deviation.'},
  {name:'STDEV.S',sig:'STDEV.S(number1, [number2], ...)',desc:'Sample standard deviation.'},
  {name:'STDEV.P',sig:'STDEV.P(number1, [number2], ...)',desc:'Population standard deviation.'},
  {name:'STDEVP',sig:'STDEVP(number1, [number2], ...)',desc:'Population standard deviation (legacy).'},
  {name:'STDEVA',sig:'STDEVA(value1, [value2], ...)',desc:'Std dev including text/logical values.'},
  {name:'STDEVPA',sig:'STDEVPA(value1, [value2], ...)',desc:'Pop std dev including text/logical values.'},
  {name:'VAR',sig:'VAR(number1, [number2], ...)',desc:'Sample variance.'},
  {name:'VAR.S',sig:'VAR.S(number1, [number2], ...)',desc:'Sample variance.'},
  {name:'VAR.P',sig:'VAR.P(number1, [number2], ...)',desc:'Population variance.'},
  {name:'VARP',sig:'VARP(number1, [number2], ...)',desc:'Population variance (legacy).'},
  {name:'VARA',sig:'VARA(value1, [value2], ...)',desc:'Sample variance including text/logical.'},
  {name:'VARPA',sig:'VARPA(value1, [value2], ...)',desc:'Pop variance including text/logical.'},
  {name:'LARGE',sig:'LARGE(array, k)',desc:'Returns the k-th largest value.'},
  {name:'SMALL',sig:'SMALL(array, k)',desc:'Returns the k-th smallest value.'},
  {name:'RANK',sig:'RANK(number, ref, [order])',desc:'Returns rank of a number in a list.'},
  {name:'RANK.EQ',sig:'RANK.EQ(number, ref, [order])',desc:'Rank — ties get same rank.'},
  {name:'RANK.AVG',sig:'RANK.AVG(number, ref, [order])',desc:'Rank — ties get average rank.'},
  {name:'QUARTILE',sig:'QUARTILE(array, quart)',desc:'Returns the quartile of a data set. quart: 0-4.'},
  {name:'QUARTILE.INC',sig:'QUARTILE.INC(array, quart)',desc:'Quartile inclusive (0-4).'},
  {name:'QUARTILE.EXC',sig:'QUARTILE.EXC(array, quart)',desc:'Quartile exclusive (1-3).'},
  {name:'PERCENTILE',sig:'PERCENTILE(array, k)',desc:'Returns the k-th percentile. k: 0 to 1.'},
  {name:'PERCENTILE.INC',sig:'PERCENTILE.INC(array, k)',desc:'k-th percentile inclusive.'},
  {name:'PERCENTILE.EXC',sig:'PERCENTILE.EXC(array, k)',desc:'k-th percentile exclusive.'},
  {name:'PERCENTRANK',sig:'PERCENTRANK(array, x)',desc:'Returns percentage rank of x in array.'},
  {name:'PERCENTRANK.INC',sig:'PERCENTRANK.INC(array, x)',desc:'Percent rank inclusive.'},
  {name:'PERCENTRANK.EXC',sig:'PERCENTRANK.EXC(array, x)',desc:'Percent rank exclusive.'},
  {name:'CORREL',sig:'CORREL(array1, array2)',desc:'Returns the correlation coefficient.'},
  {name:'PEARSON',sig:'PEARSON(array1, array2)',desc:'Pearson correlation coefficient.'},
  {name:'COVAR',sig:'COVAR(array1, array2)',desc:'Sample covariance (legacy).'},
  {name:'COVARIANCE.S',sig:'COVARIANCE.S(array1, array2)',desc:'Sample covariance.'},
  {name:'COVARIANCE.P',sig:'COVARIANCE.P(array1, array2)',desc:'Population covariance.'},
  {name:'SLOPE',sig:'SLOPE(known_ys, known_xs)',desc:'Slope of linear regression line.'},
  {name:'INTERCEPT',sig:'INTERCEPT(known_ys, known_xs)',desc:'Y-intercept of linear regression line.'},
  {name:'FORECAST',sig:'FORECAST(x, known_ys, known_xs)',desc:'Predicts y value for given x.'},
  {name:'GROWTH',sig:'GROWTH(known_ys, known_xs)',desc:'Exponential growth prediction.'},
  {name:'TREND',sig:'TREND(known_ys, known_xs)',desc:'Linear trend prediction.'},
  {name:'LINEST',sig:'LINEST(known_ys, known_xs)',desc:'Returns slope and intercept.'},
  {name:'LOGEST',sig:'LOGEST(known_ys, known_xs)',desc:'Returns exponential regression parameters.'},
  {name:'RSQ',sig:'RSQ(known_ys, known_xs)',desc:'R-squared value of linear regression.'},
  {name:'STEYX',sig:'STEYX(known_ys, known_xs)',desc:'Standard error of regression.'},
  {name:'KURT',sig:'KURT(number1, [number2], ...)',desc:'Kurtosis of a data set.'},
  {name:'SKEW',sig:'SKEW(number1, [number2], ...)',desc:'Skewness of a data set.'},
  {name:'GEOMEAN',sig:'GEOMEAN(number1, [number2], ...)',desc:'Geometric mean.'},
  {name:'HARMEAN',sig:'HARMEAN(number1, [number2], ...)',desc:'Harmonic mean.'},
  {name:'TRIMMEAN',sig:'TRIMMEAN(array, percent)',desc:'Mean excluding top/bottom percent of data.'},
  {name:'DEVSQ',sig:'DEVSQ(number1, [number2], ...)',desc:'Sum of squared deviations from mean.'},
  {name:'AVEDEV',sig:'AVEDEV(number1, [number2], ...)',desc:'Average of absolute deviations from mean.'},
  {name:'STANDARDIZE',sig:'STANDARDIZE(x, mean, standard_dev)',desc:'Returns normalised value from distribution.'},
  {name:'NORM.DIST',sig:'NORM.DIST(x, mean, standard_dev, cumulative)',desc:'Normal distribution probability.'},
  {name:'NORMDIST',sig:'NORMDIST(x, mean, standard_dev, cumulative)',desc:'Normal distribution (legacy).'},
  {name:'NORM.INV',sig:'NORM.INV(probability, mean, standard_dev)',desc:'Inverse of normal distribution.'},
  {name:'NORMINV',sig:'NORMINV(probability, mean, standard_dev)',desc:'Inverse normal distribution (legacy).'},
  {name:'NORM.S.DIST',sig:'NORM.S.DIST(z, cumulative)',desc:'Standard normal distribution.'},
  {name:'NORMSDIST',sig:'NORMSDIST(z)',desc:'Standard normal distribution (legacy).'},
  {name:'NORM.S.INV',sig:'NORM.S.INV(probability)',desc:'Inverse standard normal distribution.'},
  {name:'NORMSINV',sig:'NORMSINV(probability)',desc:'Inverse std normal distribution (legacy).'},
  {name:'T.DIST',sig:'T.DIST(x, deg_freedom, cumulative)',desc:'Student t-distribution.'},
  {name:'TDIST',sig:'TDIST(x, deg_freedom, tails)',desc:'Student t-distribution (legacy).'},
  {name:'T.INV',sig:'T.INV(probability, deg_freedom)',desc:'Inverse t-distribution.'},
  {name:'TINV',sig:'TINV(probability, deg_freedom)',desc:'Inverse t-distribution (legacy).'},
  {name:'T.TEST',sig:'T.TEST(array1, array2, tails, type)',desc:'Returns probability from t-test.'},
  {name:'TTEST',sig:'TTEST(array1, array2, tails, type)',desc:'T-test probability (legacy).'},
  {name:'CHISQ.DIST',sig:'CHISQ.DIST(x, deg_freedom, cumulative)',desc:'Chi-squared distribution.'},
  {name:'CHIDIST',sig:'CHIDIST(x, deg_freedom)',desc:'Chi-squared distribution (legacy).'},
  {name:'CHISQ.INV',sig:'CHISQ.INV(probability, deg_freedom)',desc:'Inverse chi-squared distribution.'},
  {name:'CHIINV',sig:'CHIINV(probability, deg_freedom)',desc:'Inverse chi-squared (legacy).'},
  {name:'CHISQ.TEST',sig:'CHISQ.TEST(actual_range, expected_range)',desc:'Chi-squared test for independence.'},
  {name:'CHITEST',sig:'CHITEST(actual_range, expected_range)',desc:'Chi-squared test (legacy).'},
  {name:'F.DIST',sig:'F.DIST(x, deg_freedom1, deg_freedom2, cumulative)',desc:'F probability distribution.'},
  {name:'FDIST',sig:'FDIST(x, deg_freedom1, deg_freedom2)',desc:'F distribution (legacy).'},
  {name:'F.INV',sig:'F.INV(probability, deg_freedom1, deg_freedom2)',desc:'Inverse F distribution.'},
  {name:'FINV',sig:'FINV(probability, deg_freedom1, deg_freedom2)',desc:'Inverse F distribution (legacy).'},
  {name:'F.TEST',sig:'F.TEST(array1, array2)',desc:'F-test for equality of variances.'},
  {name:'FTEST',sig:'FTEST(array1, array2)',desc:'F-test (legacy).'},
  {name:'BETA.DIST',sig:'BETA.DIST(x, alpha, beta, cumulative)',desc:'Beta distribution.'},
  {name:'BETADIST',sig:'BETADIST(x, alpha, beta)',desc:'Beta distribution (legacy).'},
  {name:'BETA.INV',sig:'BETA.INV(probability, alpha, beta)',desc:'Inverse beta distribution.'},
  {name:'BETAINV',sig:'BETAINV(probability, alpha, beta)',desc:'Inverse beta distribution (legacy).'},
  {name:'BINOM.DIST',sig:'BINOM.DIST(number_s, trials, probability_s, cumulative)',desc:'Binomial distribution.'},
  {name:'BINOMDIST',sig:'BINOMDIST(number_s, trials, probability_s, cumulative)',desc:'Binomial distribution (legacy).'},
  {name:'BINOM.DIST.RANGE',sig:'BINOM.DIST.RANGE(trials, probability_s, number_s, [number_s2])',desc:'Binomial probability range.'},
  {name:'BINOM.INV',sig:'BINOM.INV(trials, probability_s, alpha)',desc:'Inverse binomial distribution.'},
  {name:'CRITBINOM',sig:'CRITBINOM(trials, probability_s, alpha)',desc:'Binomial inverse (legacy).'},
  {name:'NEGBINOM.DIST',sig:'NEGBINOM.DIST(number_f, number_s, probability_s, cumulative)',desc:'Negative binomial distribution.'},
  {name:'NEGBINOMDIST',sig:'NEGBINOMDIST(number_f, number_s, probability_s)',desc:'Negative binomial (legacy).'},
  {name:'EXPON.DIST',sig:'EXPON.DIST(x, lambda, cumulative)',desc:'Exponential distribution.'},
  {name:'EXPONDIST',sig:'EXPONDIST(x, lambda, cumulative)',desc:'Exponential distribution (legacy).'},
  {name:'GAMMA.DIST',sig:'GAMMA.DIST(x, alpha, beta, cumulative)',desc:'Gamma distribution.'},
  {name:'GAMMADIST',sig:'GAMMADIST(x, alpha, beta, cumulative)',desc:'Gamma distribution (legacy).'},
  {name:'GAMMA.INV',sig:'GAMMA.INV(probability, alpha, beta)',desc:'Inverse gamma distribution.'},
  {name:'GAMMAINV',sig:'GAMMAINV(probability, alpha, beta)',desc:'Inverse gamma distribution (legacy).'},
  {name:'GAMMALN',sig:'GAMMALN(x)',desc:'Natural log of the gamma function.'},
  {name:'GAMMALN.PRECISE',sig:'GAMMALN.PRECISE(x)',desc:'Natural log of gamma function (precise).'},
  {name:'HYPGEOM.DIST',sig:'HYPGEOM.DIST(sample_s, number_sample, population_s, number_pop, cumulative)',desc:'Hypergeometric distribution.'},
  {name:'HYPGEOMDIST',sig:'HYPGEOMDIST(sample_s, number_sample, population_s, number_pop)',desc:'Hypergeometric distribution (legacy).'},
  {name:'LOGNORM.DIST',sig:'LOGNORM.DIST(x, mean, standard_dev, cumulative)',desc:'Log-normal distribution.'},
  {name:'LOGNORMDIST',sig:'LOGNORMDIST(x, mean, standard_dev)',desc:'Log-normal distribution (legacy).'},
  {name:'LOGNORM.INV',sig:'LOGNORM.INV(probability, mean, standard_dev)',desc:'Inverse log-normal distribution.'},
  {name:'LOGINV',sig:'LOGINV(probability, mean, standard_dev)',desc:'Inverse log-normal (legacy).'},
  {name:'POISSON',sig:'POISSON(x, mean, cumulative)',desc:'Poisson distribution.'},
  {name:'POISSON.DIST',sig:'POISSON.DIST(x, mean, cumulative)',desc:'Poisson distribution.'},
  {name:'WEIBULL',sig:'WEIBULL(x, alpha, beta, cumulative)',desc:'Weibull distribution.'},
  {name:'WEIBULL.DIST',sig:'WEIBULL.DIST(x, alpha, beta, cumulative)',desc:'Weibull distribution.'},
  {name:'PROB',sig:'PROB(x_range, prob_range, lower_limit, [upper_limit])',desc:'Probability that values in range fall between limits.'},
  {name:'FREQUENCY',sig:'FREQUENCY(data_array, bins_array)',desc:'Frequency distribution as vertical array.'},
  {name:'PERMUT',sig:'PERMUT(number, number_chosen)',desc:'Number of permutations for n items.'},
  {name:'COMBIN',sig:'COMBIN(number, number_chosen)',desc:'Number of combinations.'},
  {name:'COUNTBLANK',sig:'COUNTBLANK(range)',desc:'Counts empty cells in a range.'},
  {name:'MAXA',sig:'MAXA(value1, [value2], ...)',desc:'Max including text (=0) and logicals.'},
  {name:'MINA',sig:'MINA(value1, [value2], ...)',desc:'Min including text (=0) and logicals.'},
  {name:'FISHER',sig:'FISHER(x)',desc:'Fisher transformation.'},
  {name:'FISHERINV',sig:'FISHERINV(y)',desc:'Inverse Fisher transformation.'},
  {name:'CONFIDENCE',sig:'CONFIDENCE(alpha, standard_dev, size)',desc:'Confidence interval for population mean.'},
  {name:'CONFIDENCE.NORM',sig:'CONFIDENCE.NORM(alpha, standard_dev, size)',desc:'Confidence interval using normal distribution.'},
  {name:'CONFIDENCE.T',sig:'CONFIDENCE.T(alpha, standard_dev, size)',desc:'Confidence interval using t-distribution.'},
  // ── Financial ────────────────────────────────────────────────────────────
  {name:'FV',sig:'FV(rate, nper, pmt, [pv], [type])',desc:'Future value of an investment.'},
  {name:'PV',sig:'PV(rate, nper, pmt, [fv], [type])',desc:'Present value of an investment.'},
  {name:'RATE',sig:'RATE(nper, pmt, pv, [fv], [type])',desc:'Interest rate per period.'},
  {name:'NPER',sig:'NPER(rate, pmt, pv, [fv], [type])',desc:'Number of periods for investment.'},
  {name:'IPMT',sig:'IPMT(rate, per, nper, pv, [fv], [type])',desc:'Interest payment for given period.'},
  {name:'PPMT',sig:'PPMT(rate, per, nper, pv, [fv], [type])',desc:'Principal payment for given period.'},
  {name:'SLN',sig:'SLN(cost, salvage, life)',desc:'Straight-line depreciation.'},
  {name:'DB',sig:'DB(cost, salvage, life, period, [month])',desc:'Declining balance depreciation.'},
  {name:'IRR',sig:'IRR(values, [guess])',desc:'Internal rate of return.'},
  {name:'MIRR',sig:'MIRR(values, finance_rate, reinvest_rate)',desc:'Modified internal rate of return.'},
  {name:'XNPV',sig:'XNPV(rate, values, dates)',desc:'Net present value for irregular cash flows.'},
  {name:'XIRR',sig:'XIRR(values, dates, [guess])',desc:'IRR for irregular cash flows.'},
  // ── Date & Time ──────────────────────────────────────────────────────────
  {name:'DAYS',sig:'DAYS(end_date, start_date)',desc:'Number of days between two dates.'},
  {name:'EOMONTH',sig:'EOMONTH(start_date, months)',desc:'Last day of month after given months.'},
  {name:'WEEKDAY',sig:'WEEKDAY(date, [return_type])',desc:'Day of week as number.'},
  {name:'WEEKNUM',sig:'WEEKNUM(date, [return_type])',desc:'Week number of the year.'},
  {name:'HOUR',sig:'HOUR(time)',desc:'Returns the hour from a time value.'},
  {name:'MINUTE',sig:'MINUTE(time)',desc:'Returns the minute from a time value.'},
  {name:'SECOND',sig:'SECOND(time)',desc:'Returns the second from a time value.'},
  {name:'TIME',sig:'TIME(hour, minute, second)',desc:'Creates a time value.'},
  {name:'DATEDIF',sig:'DATEDIF(start_date, end_date, unit)',desc:'Difference between two dates. Units: Y M D YM YD MD.'},
  {name:'WORKDAY',sig:'WORKDAY(start_date, days)',desc:'Date that is n working days away.'},
  {name:'DATEVALUE',sig:'DATEVALUE(date_text)',desc:'Converts date text to serial number.'},
  {name:'TIMEVALUE',sig:'TIMEVALUE(time_text)',desc:'Converts time text to decimal fraction.'},
  {name:'ISOWEEKNUM',sig:'ISOWEEKNUM(date)',desc:'ISO week number of the year.'},
  // ── Text ─────────────────────────────────────────────────────────────────
  {name:'SEARCH',sig:'SEARCH(find_text, within_text, [start_num])',desc:'Finds text position (case-insensitive).'},
  {name:'REPLACE',sig:'REPLACE(old_text, start_num, num_chars, new_text)',desc:'Replaces characters by position.'},
  {name:'CLEAN',sig:'CLEAN(text)',desc:'Removes non-printable characters.'},
  {name:'FIXED',sig:'FIXED(number, [decimals], [no_commas])',desc:'Rounds and formats number as text.'},
  {name:'DOLLAR',sig:'DOLLAR(number, [decimals])',desc:'Formats number as dollar currency text.'},
  {name:'TEXTJOIN',sig:'TEXTJOIN(delimiter, ignore_empty, text1, [text2], ...)',desc:'Joins text with delimiter.'},
  {name:'NUMBERVALUE',sig:'NUMBERVALUE(text)',desc:'Converts text to number.'},
  {name:'UNICHAR',sig:'UNICHAR(number)',desc:'Returns Unicode character for number.'},
  {name:'UNICODE',sig:'UNICODE(text)',desc:'Returns Unicode code of first character.'},
  // ── Information ──────────────────────────────────────────────────────────
  {name:'ISERROR',sig:'ISERROR(value)',desc:'Returns TRUE if value is any error.'},
  {name:'ISNA',sig:'ISNA(value)',desc:'Returns TRUE if value is #N/A.'},
  {name:'ISLOGICAL',sig:'ISLOGICAL(value)',desc:'Returns TRUE if value is logical.'},
  {name:'ISODD',sig:'ISODD(number)',desc:'Returns TRUE if number is odd.'},
  {name:'ISEVEN',sig:'ISEVEN(number)',desc:'Returns TRUE if number is even.'},
  {name:'ISNONTEXT',sig:'ISNONTEXT(value)',desc:'Returns TRUE if value is not text.'},
  {name:'N',sig:'N(value)',desc:'Converts value to a number.'},
  {name:'NA',sig:'NA()',desc:'Returns the #N/A error value.'},
  // ── Logical ──────────────────────────────────────────────────────────────
  {name:'XOR',sig:'XOR(logical1, [logical2], ...)',desc:'Returns TRUE if odd number of arguments are TRUE.'},
  {name:'SWITCH',sig:'SWITCH(expression, value1, result1, [default])',desc:'Matches expression against values.'},
  // ── Math ─────────────────────────────────────────────────────────────────
  {name:'SUMIFS',sig:'SUMIFS(sum_range, criteria_range1, criteria1, ...)',desc:'Sum cells meeting multiple criteria.'},
  {name:'AVERAGEIFS',sig:'AVERAGEIFS(average_range, criteria_range1, criteria1, ...)',desc:'Average cells meeting multiple criteria.'},
  {name:'EXP',sig:'EXP(number)',desc:'Returns e raised to the power of number.'},
  {name:'SIGN',sig:'SIGN(number)',desc:'Returns 1, 0, or -1 for positive/zero/negative.'},
  {name:'TRUNC',sig:'TRUNC(number, [num_digits])',desc:'Truncates number to integer.'},
  {name:'EVEN',sig:'EVEN(number)',desc:'Rounds up to nearest even integer.'},
  {name:'ODD',sig:'ODD(number)',desc:'Rounds up to nearest odd integer.'},
  {name:'FACT',sig:'FACT(number)',desc:'Factorial of a number.'},
  {name:'FACTDOUBLE',sig:'FACTDOUBLE(number)',desc:'Double factorial of a number.'},
  {name:'GCD',sig:'GCD(number1, [number2], ...)',desc:'Greatest common divisor.'},
  {name:'LCM',sig:'LCM(number1, [number2], ...)',desc:'Least common multiple.'},
  {name:'COMBIN',sig:'COMBIN(number, number_chosen)',desc:'Number of combinations.'},
  {name:'COMBINA',sig:'COMBINA(number, number_chosen)',desc:'Number of combinations with repetition.'},
  {name:'PERMUT',sig:'PERMUT(number, number_chosen)',desc:'Number of permutations.'},
  {name:'RANDBETWEEN',sig:'RANDBETWEEN(bottom, top)',desc:'Random integer between two numbers.'},
  {name:'MROUND',sig:'MROUND(number, multiple)',desc:'Rounds to nearest multiple.'},
  {name:'DEGREES',sig:'DEGREES(angle)',desc:'Converts radians to degrees.'},
  {name:'RADIANS',sig:'RADIANS(angle)',desc:'Converts degrees to radians.'},
  {name:'PRODUCT',sig:'PRODUCT(number1, [number2], ...)',desc:'Multiplies all arguments.'},
  {name:'QUOTIENT',sig:'QUOTIENT(numerator, denominator)',desc:'Integer part of division.'},
  {name:'COS',sig:'COS(number)',desc:'Cosine of angle (in radians).'},
  {name:'SIN',sig:'SIN(number)',desc:'Sine of angle (in radians).'},
  {name:'TAN',sig:'TAN(number)',desc:'Tangent of angle (in radians).'},
  {name:'ACOS',sig:'ACOS(number)',desc:'Arccosine of a number.'},
  {name:'ASIN',sig:'ASIN(number)',desc:'Arcsine of a number.'},
  {name:'ATAN',sig:'ATAN(number)',desc:'Arctangent of a number.'},
  {name:'ATAN2',sig:'ATAN2(x_num, y_num)',desc:'Arctangent from x and y coordinates.'},
  {name:'SUBTOTAL',sig:'SUBTOTAL(function_num, ref1, ...)',desc:'Subtotal using function (1=AVG, 9=SUM, etc).'},
  // ── Financial (extended) ─────────────────────────────────────────────────
  {name:'ACCRINT',sig:'ACCRINT(issue, first, settle, rate, par, freq)',desc:'Accrued interest for periodic coupon security.'},
  {name:'ACCRINTM',sig:'ACCRINTM(issue, settle, rate, par)',desc:'Accrued interest for maturity-paying security.'},
  {name:'AMORDEGRC',sig:'AMORDEGRC(cost, date, first_period, salvage, period, rate)',desc:'Depreciation using declining balance.'},
  {name:'AMORLINC',sig:'AMORLINC(cost, date, first_period, salvage, period, rate)',desc:'Depreciation using linear method.'},
  {name:'COUPDAYBS',sig:'COUPDAYBS(settle, maturity, freq)',desc:'Days from coupon start to settlement.'},
  {name:'COUPDAYS',sig:'COUPDAYS(settle, maturity, freq)',desc:'Days in coupon period.'},
  {name:'COUPDAYSNC',sig:'COUPDAYSNC(settle, maturity, freq)',desc:'Days from settlement to next coupon.'},
  {name:'COUPNCD',sig:'COUPNCD(settle, maturity, freq)',desc:'Next coupon date after settlement.'},
  {name:'COUPNUM',sig:'COUPNUM(settle, maturity, freq)',desc:'Number of coupons payable between settlement and maturity.'},
  {name:'COUPPCD',sig:'COUPPCD(settle, maturity, freq)',desc:'Previous coupon date before settlement.'},
  {name:'CUMIPMT',sig:'CUMIPMT(rate, nper, pv, start, end, type)',desc:'Cumulative interest paid between two periods.'},
  {name:'CUMPRINC',sig:'CUMPRINC(rate, nper, pv, start, end, type)',desc:'Cumulative principal paid between two periods.'},
  {name:'DDB',sig:'DDB(cost, salvage, life, period, [factor])',desc:'Double-declining balance depreciation.'},
  {name:'DISC',sig:'DISC(settle, maturity, pr, redemption)',desc:'Discount rate for a security.'},
  {name:'DOLLARDE',sig:'DOLLARDE(fractional_dollar, fraction)',desc:'Converts dollar price from fractional to decimal.'},
  {name:'DOLLARFR',sig:'DOLLARFR(decimal_dollar, fraction)',desc:'Converts dollar price from decimal to fractional.'},
  {name:'DURATION',sig:'DURATION(settle, maturity, coupon, yld, freq)',desc:'Annual duration of a security with periodic interest.'},
  {name:'FVSCHEDULE',sig:'FVSCHEDULE(principal, schedule)',desc:'Future value with variable interest rates.'},
  {name:'INTRATE',sig:'INTRATE(settle, maturity, investment, redemption)',desc:'Interest rate for fully invested security.'},
  {name:'ISPMT',sig:'ISPMT(rate, per, nper, pv)',desc:'Interest paid during a period.'},
  {name:'MDURATION',sig:'MDURATION(settle, maturity, coupon, yld, freq)',desc:'Modified Macaulay duration.'},
  {name:'NOMINAL',sig:'NOMINAL(effect_rate, npery)',desc:'Annual nominal interest rate.'},
  {name:'ODDFPRICE',sig:'ODDFPRICE(settle, maturity, issue, first_coupon, rate, yld, redemption, freq)',desc:'Price per $100 for odd first period.'},
  {name:'ODDFYIELD',sig:'ODDFYIELD(settle, maturity, issue, first_coupon, rate, pr, redemption, freq)',desc:'Yield for odd first period.'},
  {name:'ODDLPRICE',sig:'ODDLPRICE(settle, maturity, last_interest, rate, yld, redemption, freq)',desc:'Price per $100 for odd last period.'},
  {name:'ODDLYIELD',sig:'ODDLYIELD(settle, maturity, last_interest, rate, pr, redemption, freq)',desc:'Yield for odd last period.'},
  {name:'PDURATION',sig:'PDURATION(rate, pv, fv)',desc:'Periods for investment to reach value.'},
  {name:'PRICE',sig:'PRICE(settle, maturity, rate, yld, redemption, freq)',desc:'Price per $100 face value of periodic security.'},
  {name:'PRICEDISC',sig:'PRICEDISC(settle, maturity, discount, redemption)',desc:'Price per $100 of discounted security.'},
  {name:'PRICEMAT',sig:'PRICEMAT(settle, maturity, issue, rate, yld)',desc:'Price per $100 paying interest at maturity.'},
  {name:'RECEIVED',sig:'RECEIVED(settle, maturity, investment, discount)',desc:'Amount received at maturity for fully invested security.'},
  {name:'RRI',sig:'RRI(nper, pv, fv)',desc:'Equivalent interest rate for investment growth.'},
  {name:'SYD',sig:'SYD(cost, salvage, life, period)',desc:'Sum-of-years\' digits depreciation.'},
  {name:'TBILLEQ',sig:'TBILLEQ(settle, maturity, discount)',desc:'Bond-equivalent yield for T-bill.'},
  {name:'TBILLPRICE',sig:'TBILLPRICE(settle, maturity, discount)',desc:'Price per $100 for T-bill.'},
  {name:'TBILLYIELD',sig:'TBILLYIELD(settle, maturity, pr)',desc:'Yield for T-bill.'},
  {name:'VDB',sig:'VDB(cost, salvage, life, start, end, [factor])',desc:'Variable declining balance depreciation.'},
  {name:'YIELD',sig:'YIELD(settle, maturity, rate, pr, redemption, freq)',desc:'Yield on a security that pays periodic interest.'},
  {name:'YIELDDISC',sig:'YIELDDISC(settle, maturity, pr, redemption)',desc:'Annual yield for discounted security.'},
  {name:'YIELDMAT',sig:'YIELDMAT(settle, maturity, issue, rate, pr)',desc:'Annual yield of security paying interest at maturity.'},
  // ── Logical (extended) ───────────────────────────────────────────────────
  {name:'BYCOL',sig:'BYCOL(array, lambda)',desc:'Applies lambda to each column of array.'},
  {name:'BYROW',sig:'BYROW(array, lambda)',desc:'Applies lambda to each row of array.'},
  {name:'FALSE',sig:'FALSE()',desc:'Returns the logical value FALSE.'},
  {name:'IFNA',sig:'IFNA(value, value_if_na)',desc:'Returns value_if_na if value is #N/A.'},
  {name:'LAMBDA',sig:'LAMBDA([param1, ...], calculation)',desc:'Creates a custom reusable function.'},
  {name:'LET',sig:'LET(name1, value1, ..., calculation)',desc:'Assigns names to calculation results.'},
  {name:'MAKEARRAY',sig:'MAKEARRAY(rows, cols, lambda)',desc:'Returns calculated array of given size.'},
  {name:'MAP',sig:'MAP(array, lambda)',desc:'Maps each value in array using lambda.'},
  {name:'REDUCE',sig:'REDUCE(initial, array, lambda)',desc:'Reduces array to single value using lambda.'},
  {name:'SCAN',sig:'SCAN(initial, array, lambda)',desc:'Returns array of accumulated values.'},
  {name:'TRUE',sig:'TRUE()',desc:'Returns the logical value TRUE.'},
  // ── Text (extended) ──────────────────────────────────────────────────────
  {name:'ARRAYTOTEXT',sig:'ARRAYTOTEXT(array, [format])',desc:'Returns text representation of array.'},
  {name:'ASC',sig:'ASC(text)',desc:'Converts full-width characters to half-width.'},
  {name:'BAHTTEXT',sig:'BAHTTEXT(number)',desc:'Converts number to Thai Baht text.'},
  {name:'DBCS',sig:'DBCS(text)',desc:'Converts half-width to full-width characters.'},
  {name:'ENCODEURL',sig:'ENCODEURL(text)',desc:'Returns URL-encoded string.'},
  {name:'FINDB',sig:'FINDB(find_text, within_text, [start_num])',desc:'Finds byte position of text (case-sensitive).'},
  {name:'FORMULATEXT',sig:'FORMULATEXT(reference)',desc:'Returns formula as text string.'},
  {name:'LEFTB',sig:'LEFTB(text, [num_bytes])',desc:'Returns leftmost bytes from text.'},
  {name:'LENB',sig:'LENB(text)',desc:'Returns byte length of text.'},
  {name:'MIDB',sig:'MIDB(text, start_num, num_bytes)',desc:'Returns characters from middle by bytes.'},
  {name:'NUMBERSTRING',sig:'NUMBERSTRING(number, type)',desc:'Converts number to Chinese text.'},
  {name:'PERCENTOF',sig:'PERCENTOF(value, total)',desc:'Returns value as percentage of total.'},
  {name:'REPLACEB',sig:'REPLACEB(old_text, start_num, num_bytes, new_text)',desc:'Replaces bytes by position.'},
  {name:'RIGHTB',sig:'RIGHTB(text, [num_bytes])',desc:'Returns rightmost bytes from text.'},
  {name:'SEARCHB',sig:'SEARCHB(find_text, within_text, [start_num])',desc:'Finds byte position (case-insensitive).'},
  {name:'SUBSTITUTES',sig:'SUBSTITUTES(text, old_text, new_text)',desc:'Replaces all occurrences of old_text.'},
  {name:'T',sig:'T(value)',desc:'Returns text if value is text, else empty string.'},
  {name:'TEXTAFTER',sig:'TEXTAFTER(text, delimiter, [n])',desc:'Returns text after nth delimiter.'},
  {name:'TEXTBEFORE',sig:'TEXTBEFORE(text, delimiter, [n])',desc:'Returns text before nth delimiter.'},
  {name:'TEXTSPLIT',sig:'TEXTSPLIT(text, col_delimiter, [row_delimiter])',desc:'Splits text by delimiter.'},
  {name:'USDOLLAR',sig:'USDOLLAR(number, [decimals])',desc:'Formats number as US dollar text.'},
  // ── Date & Time (extended) ───────────────────────────────────────────────
  {name:'DAYS360',sig:'DAYS360(start_date, end_date, [method])',desc:'Days between dates using 360-day year.'},
  {name:'NETWORKDAYS.INTL',sig:'NETWORKDAYS.INTL(start, end, [weekend], [holidays])',desc:'Working days excluding custom weekends.'},
  {name:'WORKDAY.INTL',sig:'WORKDAY.INTL(start, days, [weekend])',desc:'Date n working days away with custom weekends.'},
  {name:'YEARFRAC',sig:'YEARFRAC(start_date, end_date, [basis])',desc:'Year fraction between two dates.'},
  // ── Lookup (extended) ────────────────────────────────────────────────────
  {name:'ADDRESS',sig:'ADDRESS(row, col, [abs], [a1], [sheet])',desc:'Returns cell address as text.'},
  {name:'AREAS',sig:'AREAS(reference)',desc:'Returns number of areas in reference.'},
  {name:'CHOOSECOLS',sig:'CHOOSECOLS(array, col1, [col2], ...)',desc:'Returns specified columns from array.'},
  {name:'CHOOSEROWS',sig:'CHOOSEROWS(array, row1, [row2], ...)',desc:'Returns specified rows from array.'},
  {name:'COLUMN',sig:'COLUMN([reference])',desc:'Returns column number of reference.'},
  {name:'COLUMNS',sig:'COLUMNS(array)',desc:'Returns number of columns in array.'},
  {name:'DROP',sig:'DROP(array, rows, [cols])',desc:'Drops rows/cols from start or end of array.'},
  {name:'EXPAND',sig:'EXPAND(array, rows, [cols], [pad])',desc:'Expands array to specified dimensions.'},
  {name:'FILTER',sig:'FILTER(array, include, [if_empty])',desc:'Filters array based on criteria.'},
  {name:'HSTACK',sig:'HSTACK(array1, [array2], ...)',desc:'Appends arrays horizontally.'},
  {name:'OFFSET',sig:'OFFSET(reference, rows, cols, [height], [width])',desc:'Returns reference offset from given reference.'},
  {name:'ROW',sig:'ROW([reference])',desc:'Returns row number of reference.'},
  {name:'ROWS',sig:'ROWS(array)',desc:'Returns number of rows in array.'},
  {name:'SORT',sig:'SORT(array, [sort_index], [sort_order])',desc:'Sorts contents of range or array.'},
  {name:'SORTBY',sig:'SORTBY(array, by_array, [sort_order])',desc:'Sorts array by values in another array.'},
  {name:'TAKE',sig:'TAKE(array, rows, [cols])',desc:'Returns rows/cols from start or end of array.'},
  {name:'TOCOL',sig:'TOCOL(array, [ignore], [scan_by_col])',desc:'Returns array as single column.'},
  {name:'TOROW',sig:'TOROW(array, [ignore], [scan_by_row])',desc:'Returns array as single row.'},
  {name:'TRANSPOSE',sig:'TRANSPOSE(array)',desc:'Transposes rows and columns of array.'},
  {name:'UNIQUE',sig:'UNIQUE(array, [by_col], [exactly_once])',desc:'Returns unique rows or columns.'},
  {name:'VSTACK',sig:'VSTACK(array1, [array2], ...)',desc:'Appends arrays vertically.'},
  {name:'WRAPCOLS',sig:'WRAPCOLS(vector, wrap_count, [pad])',desc:'Wraps column vector into 2D array by columns.'},
  {name:'WRAPROWS',sig:'WRAPROWS(vector, wrap_count, [pad])',desc:'Wraps row vector into 2D array by rows.'},
  {name:'XLOOKUP',sig:'XLOOKUP(lookup, lookup_array, return_array, [not_found])',desc:'Searches range and returns match.'},
  {name:'XMATCH',sig:'XMATCH(lookup, lookup_array, [match_mode])',desc:'Returns relative position of item in array.'},
  // ── Math & Trig (extended) ───────────────────────────────────────────────
  {name:'ACOT',sig:'ACOT(number)',desc:'Arccotangent of a number.'},
  {name:'ACOTH',sig:'ACOTH(number)',desc:'Inverse hyperbolic cotangent.'},
  {name:'ACOSH',sig:'ACOSH(number)',desc:'Inverse hyperbolic cosine.'},
  {name:'ASINH',sig:'ASINH(number)',desc:'Inverse hyperbolic sine.'},
  {name:'ATANH',sig:'ATANH(number)',desc:'Inverse hyperbolic tangent.'},
  {name:'COSH',sig:'COSH(number)',desc:'Hyperbolic cosine.'},
  {name:'COT',sig:'COT(number)',desc:'Cotangent of angle (in radians).'},
  {name:'COTH',sig:'COTH(number)',desc:'Hyperbolic cotangent.'},
  {name:'CSC',sig:'CSC(number)',desc:'Cosecant of angle (in radians).'},
  {name:'CSCH',sig:'CSCH(number)',desc:'Hyperbolic cosecant.'},
  {name:'SEC',sig:'SEC(number)',desc:'Secant of angle (in radians).'},
  {name:'SECH',sig:'SECH(number)',desc:'Hyperbolic secant.'},
  {name:'SINH',sig:'SINH(number)',desc:'Hyperbolic sine.'},
  {name:'TANH',sig:'TANH(number)',desc:'Hyperbolic tangent.'},
  {name:'LOG10',sig:'LOG10(number)',desc:'Base-10 logarithm of a number.'},
  {name:'SQRTPI',sig:'SQRTPI(number)',desc:'Square root of number * PI.'},
  {name:'SUMSQ',sig:'SUMSQ(number1, [number2], ...)',desc:'Sum of squares of arguments.'},
  {name:'SUMX2MY2',sig:'SUMX2MY2(array_x, array_y)',desc:'Sum of difference of squares of two arrays.'},
  {name:'SUMX2PY2',sig:'SUMX2PY2(array_x, array_y)',desc:'Sum of sum of squares of two arrays.'},
  {name:'MDETERM',sig:'MDETERM(array)',desc:'Matrix determinant of an array.'},
  {name:'MMULT',sig:'MMULT(array1, array2)',desc:'Matrix product of two arrays.'},
  {name:'MINVERSE',sig:'MINVERSE(array)',desc:'Matrix inverse of an array.'},
  {name:'MULTINOMIAL',sig:'MULTINOMIAL(number1, [number2], ...)',desc:'Multinomial of a set of numbers.'},
  {name:'SERIESSUM',sig:'SERIESSUM(x, n, m, coefficients)',desc:'Sum of power series.'},
  {name:'SEQUENCE',sig:'SEQUENCE(rows, [cols], [start], [step])',desc:'Generates sequence of numbers.'},
  {name:'RANDARRAY',sig:'RANDARRAY([rows], [cols])',desc:'Returns array of random numbers.'},
  {name:'ROUNDBANK',sig:'ROUNDBANK(number, num_digits)',desc:'Rounds using banker\'s rounding (round half to even).'},
  {name:'BASE',sig:'BASE(number, radix, [min_length])',desc:'Converts number to text in given base.'},
  {name:'DECIMAL',sig:'DECIMAL(text, radix)',desc:'Converts text in given base to decimal.'},
  {name:'ARABIC',sig:'ARABIC(text)',desc:'Converts Roman numeral to Arabic number.'},
  {name:'MAXIFS',sig:'MAXIFS(max_range, criteria_range1, criteria1, ...)',desc:'Max value meeting multiple criteria.'},
  {name:'MINIFS',sig:'MINIFS(min_range, criteria_range1, criteria1, ...)',desc:'Min value meeting multiple criteria.'},
  {name:'AGGREGATE',sig:'AGGREGATE(function_num, options, ref1, ...)',desc:'Aggregate function ignoring errors/hidden rows.'},
  // ── Information (extended) ───────────────────────────────────────────────
  {name:'BOOKNAME',sig:'BOOKNAME()',desc:'Returns name of current workbook.'},
  {name:'ISERR',sig:'ISERR(value)',desc:'Returns TRUE if value is any error except #N/A.'},
  {name:'ISFORMULA',sig:'ISFORMULA(reference)',desc:'Returns TRUE if cell contains a formula.'},
  {name:'ISOMITTED',sig:'ISOMITTED(argument)',desc:'Returns TRUE if LAMBDA argument was omitted.'},
  {name:'ISREF',sig:'ISREF(value)',desc:'Returns TRUE if value is a valid reference.'},
  {name:'PHONETIC',sig:'PHONETIC(reference)',desc:'Returns phonetic text from a string.'},
  {name:'SHEET',sig:'SHEET()',desc:'Returns sheet number of current sheet.'},
  {name:'SHEETS',sig:'SHEETS()',desc:'Returns number of sheets in workbook.'},
  {name:'SHEETSNAME',sig:'SHEETSNAME()',desc:'Returns name of current sheet.'},
  {name:'TYPE',sig:'TYPE(value)',desc:'Returns number indicating type of value.'},
  {name:'INFO',sig:'INFO(type)',desc:'Returns information about current environment.'},
  // ── Engineering ──────────────────────────────────────────────────────────
  {name:'BESSELI',sig:'BESSELI(x, n)',desc:'Modified Bessel function In(x).'},
  {name:'BESSELJ',sig:'BESSELJ(x, n)',desc:'Bessel function Jn(x).'},
  {name:'BESSELK',sig:'BESSELK(x, n)',desc:'Modified Bessel function Kn(x).'},
  {name:'BESSELY',sig:'BESSELY(x, n)',desc:'Bessel function Yn(x).'},
  {name:'BIN2DEC',sig:'BIN2DEC(number)',desc:'Converts binary to decimal.'},
  {name:'BIN2HEX',sig:'BIN2HEX(number, [places])',desc:'Converts binary to hexadecimal.'},
  {name:'BIN2OCT',sig:'BIN2OCT(number, [places])',desc:'Converts binary to octal.'},
  {name:'BITAND',sig:'BITAND(number1, number2)',desc:'Bitwise AND of two numbers.'},
  {name:'BITLSHIFT',sig:'BITLSHIFT(number, shift_amount)',desc:'Left-shifts number by shift_amount bits.'},
  {name:'BITOR',sig:'BITOR(number1, number2)',desc:'Bitwise OR of two numbers.'},
  {name:'BITRSHIFT',sig:'BITRSHIFT(number, shift_amount)',desc:'Right-shifts number by shift_amount bits.'},
  {name:'BITXOR',sig:'BITXOR(number1, number2)',desc:'Bitwise XOR of two numbers.'},
  {name:'COMPLEX',sig:'COMPLEX(real, imaginary, [suffix])',desc:'Converts real and imaginary to complex number.'},
  {name:'CONVERT',sig:'CONVERT(number, from_unit, to_unit)',desc:'Converts number from one unit to another.'},
  {name:'DEC2BIN',sig:'DEC2BIN(number, [places])',desc:'Converts decimal to binary.'},
  {name:'DEC2HEX',sig:'DEC2HEX(number, [places])',desc:'Converts decimal to hexadecimal.'},
  {name:'DEC2OCT',sig:'DEC2OCT(number, [places])',desc:'Converts decimal to octal.'},
  {name:'DELTA',sig:'DELTA(number1, [number2])',desc:'Returns 1 if numbers are equal, else 0.'},
  {name:'ERF',sig:'ERF(lower, [upper])',desc:'Error function.'},
  {name:'ERFC',sig:'ERFC(x)',desc:'Complementary error function.'},
  {name:'GESTEP',sig:'GESTEP(number, [step])',desc:'Returns 1 if number >= step, else 0.'},
  {name:'HEX2BIN',sig:'HEX2BIN(number, [places])',desc:'Converts hexadecimal to binary.'},
  {name:'HEX2DEC',sig:'HEX2DEC(number)',desc:'Converts hexadecimal to decimal.'},
  {name:'HEX2OCT',sig:'HEX2OCT(number, [places])',desc:'Converts hexadecimal to octal.'},
  {name:'IMABS',sig:'IMABS(inumber)',desc:'Absolute value (modulus) of complex number.'},
  {name:'IMAGINARY',sig:'IMAGINARY(inumber)',desc:'Imaginary coefficient of complex number.'},
  {name:'IMARGUMENT',sig:'IMARGUMENT(inumber)',desc:'Argument (angle) of complex number in radians.'},
  {name:'IMCONJUGATE',sig:'IMCONJUGATE(inumber)',desc:'Complex conjugate of complex number.'},
  {name:'IMCOS',sig:'IMCOS(inumber)',desc:'Cosine of complex number.'},
  {name:'IMCOSH',sig:'IMCOSH(inumber)',desc:'Hyperbolic cosine of complex number.'},
  {name:'IMCOT',sig:'IMCOT(inumber)',desc:'Cotangent of complex number.'},
  {name:'IMCSC',sig:'IMCSC(inumber)',desc:'Cosecant of complex number.'},
  {name:'IMCSCH',sig:'IMCSCH(inumber)',desc:'Hyperbolic cosecant of complex number.'},
  {name:'IMDIV',sig:'IMDIV(inumber1, inumber2)',desc:'Quotient of two complex numbers.'},
  {name:'IMEXP',sig:'IMEXP(inumber)',desc:'Exponential of complex number.'},
  {name:'IMLN',sig:'IMLN(inumber)',desc:'Natural logarithm of complex number.'},
  {name:'IMLOG10',sig:'IMLOG10(inumber)',desc:'Base-10 logarithm of complex number.'},
  {name:'IMLOG2',sig:'IMLOG2(inumber)',desc:'Base-2 logarithm of complex number.'},
  {name:'IMPOWER',sig:'IMPOWER(inumber, number)',desc:'Complex number raised to a power.'},
  {name:'IMPRODUCT',sig:'IMPRODUCT(inumber1, [inumber2], ...)',desc:'Product of complex numbers.'},
  {name:'IMREAL',sig:'IMREAL(inumber)',desc:'Real coefficient of complex number.'},
  {name:'IMSEC',sig:'IMSEC(inumber)',desc:'Secant of complex number.'},
  {name:'IMSECH',sig:'IMSECH(inumber)',desc:'Hyperbolic secant of complex number.'},
  {name:'IMSIN',sig:'IMSIN(inumber)',desc:'Sine of complex number.'},
  {name:'IMSINH',sig:'IMSINH(inumber)',desc:'Hyperbolic sine of complex number.'},
  {name:'IMSQRT',sig:'IMSQRT(inumber)',desc:'Square root of complex number.'},
  {name:'IMSUB',sig:'IMSUB(inumber1, inumber2)',desc:'Difference of two complex numbers.'},
  {name:'IMSUM',sig:'IMSUM(inumber1, [inumber2], ...)',desc:'Sum of complex numbers.'},
  {name:'IMTAN',sig:'IMTAN(inumber)',desc:'Tangent of complex number.'},
  {name:'OCT2BIN',sig:'OCT2BIN(number, [places])',desc:'Converts octal to binary.'},
  {name:'OCT2DEC',sig:'OCT2DEC(number)',desc:'Converts octal to decimal.'},
  {name:'OCT2HEX',sig:'OCT2HEX(number, [places])',desc:'Converts octal to hexadecimal.'}
];

var _acDrop = null;   // dropdown element
var _acSig  = null;   // signature tooltip element
var _acInp  = null;   // which input is active

function createAcElements(){
  if(_acDrop) return;
  _acDrop = document.createElement('div');
  _acDrop.id = 'ac-drop';
  _acDrop.style.cssText = 'display:none;position:fixed;background:#fff;border:1px solid #1e6e3a;border-radius:4px;z-index:9999;max-height:180px;overflow-y:auto;box-shadow:2px 4px 12px rgba(0,0,0,0.18);min-width:180px;';
  document.body.appendChild(_acDrop);

  _acSig = document.createElement('div');
  _acSig.id = 'ac-sig';
  _acSig.style.cssText = 'display:none;position:fixed;background:#fffde7;border:1px solid #f9a825;border-radius:4px;z-index:9999;padding:5px 10px;font-size:11px;font-family:Consolas,monospace;box-shadow:2px 4px 8px rgba(0,0,0,0.12);max-width:420px;pointer-events:none;';
  document.body.appendChild(_acSig);
}

function hideAc(){
  if(_acDrop) _acDrop.style.display='none';
  if(_acSig)  _acSig.style.display='none';
}

function showAcSig(fn, inputEl){
  if(!_acSig) return;
  var rect = inputEl.getBoundingClientRect();
  _acSig.innerHTML = '<span style="color:#1e6e3a;font-weight:bold">'+fn.sig+'</span><br><span style="color:#555;font-family:Arial,sans-serif;font-size:10px">'+fn.desc+'</span>';
  _acSig.style.display = 'block';
  // Measure popup size
  var sw = _acSig.offsetWidth;
  var sh = _acSig.offsetHeight;
  var spaceRight = window.innerWidth - rect.right - 8;
  var spaceBelow = window.innerHeight - rect.bottom - 8;
  if(spaceRight >= sw) {
    // Show to the RIGHT of the cell
    _acSig.style.left = (rect.right + 4) + 'px';
    _acSig.style.top  = rect.top + 'px';
  } else if(spaceBelow >= sh) {
    // Show BELOW the cell
    _acSig.style.left = rect.left + 'px';
    _acSig.style.top  = (rect.bottom + 4) + 'px';
  } else {
    // Fallback: show above
    _acSig.style.left = rect.left + 'px';
    _acSig.style.top  = (rect.top - sh - 4) + 'px';
  }
  if(_acDrop) _acDrop.style.display = 'none';
}

function showAcDrop(matches, inputEl, onPick){
  if(!_acDrop) return;
  if(!matches.length){ hideAc(); return; }
  _acDrop.innerHTML = '';
  var rect = inputEl.getBoundingClientRect();
  _acDrop.style.left = rect.left + 'px';
  _acDrop.style.top  = (rect.bottom + 2) + 'px';
  matches.forEach(function(fn){
    var item = document.createElement('div');
    item.style.cssText = 'padding:4px 10px;cursor:pointer;font-size:11px;font-family:Consolas,monospace;color:#1e6e3a;border-bottom:1px solid #f0f0f0;';
    item.innerHTML = '<b>'+fn.name+'</b> <span style="color:#888;font-size:10px">'+fn.sig.replace(fn.name,'')+'</span>';
    item.title = fn.desc;
    item.addEventListener('mouseenter',function(){item.style.background='#e8f5e9';});
    item.addEventListener('mouseleave',function(){item.style.background='';});
    item.addEventListener('mousedown',function(e){
      e.preventDefault();
      onPick(fn.name);
    });
    _acDrop.appendChild(item);
  });
  _acDrop.style.display = 'block';
  if(_acSig) _acSig.style.display = 'none';
}

function handleAcInput(val, inputEl, onPick){
  if(!val || !val.startsWith('=')){ hideAc(); return; }
  var expr = val.slice(1);

  // If inside a function call already — show its signature tooltip
  var insideMatch = expr.match(/([A-Z]+)\([^)]*$/i);
  if(insideMatch){
    var fn = FORMULA_LIST.find(function(f){ return f.name === insideMatch[1].toUpperCase(); });
    if(fn){ showAcSig(fn, inputEl); return; }
  }

  // Get the partial function name being typed
  var m = expr.match(/([A-Za-z]*)$/);
  var word = m ? m[1].toUpperCase() : '';

  // Show all functions on just '=', or filter by typed letters
  var matches = word.length === 0
    ? FORMULA_LIST.slice(0, 12)   // show first 12 on bare '='
    : FORMULA_LIST.filter(function(f){ return f.name.startsWith(word); });

  if(matches.length > 0){
    showAcDrop(matches, inputEl, function(name){
      var newVal = val.replace(/([A-Za-z]*)$/, name + '(');
      inputEl.value = newVal;
      inputEl.focus();
      hideAc();
      var picked = FORMULA_LIST.find(function(f){ return f.name===name; });
      if(picked) showAcSig(picked, inputEl);
      if(onPick) onPick(newVal);
    });
  } else {
    hideAc();
  }
}

// Close dropdown on outside click
document.addEventListener('mousedown', function(e){
  if(_acDrop && !_acDrop.contains(e.target)) hideAc();
});

function startInlineEdit(r,c,initialChar){
  if(editMode)commitEdit();
  if(sheetProtected&&lockedCells.has(cellId(r,c))){alert('Cell is locked.');return;}
  createAcElements();
  editMode=true;_activeR=r;_activeC=c;
  var dv=document.getElementById('d-'+r+'-'+c);if(!dv)return;
  var inp=document.createElement('input');inp.type='text';
  inp.style.cssText='width:100%;height:100%;border:none;outline:none;background:#fffde7;padding:0 4px;font-size:11px;font-family:Arial,sans-serif;color:#111;box-sizing:border-box;';
  inp.value=initialChar!==undefined?initialChar:getRaw(r,c);
  _activeInp=inp;dv.textContent='';dv.appendChild(inp);
  requestAnimationFrame(function(){inp.focus();if(initialChar===undefined)inp.select();else inp.setSelectionRange(inp.value.length,inp.value.length);});

  inp.addEventListener('input',function(){
    document.getElementById('formula-input').value=inp.value;
    handleAcInput(inp.value, inp, function(newVal){ inp.value=newVal; });
  });
  // Also fire on keyup so = shows dropdown immediately on first keystroke
  inp.addEventListener('keyup',function(e){
    if(e.key==='=' || inp.value==='=') handleAcInput(inp.value, inp, function(newVal){ inp.value=newVal; });
  });
  inp.addEventListener('keydown',function(e){
    if(e.key==='Escape'){
      if(_acDrop&&_acDrop.style.display!=='none'){hideAc();e.preventDefault();e.stopPropagation();return;}
      cancelEdit();e.preventDefault();
    }
    if(e.key==='Enter'){
      hideAc();commitEdit();if(r<ROWS-1)selectCell(r+1,c);e.preventDefault();
    }
    if(e.key==='Tab'){hideAc();commitEdit();if(c<COLS-1)selectCell(r,c+1);else selectCell(r+1,0);e.preventDefault();}
    if(e.key==='ArrowUp'&&(!_acDrop||_acDrop.style.display==='none')){commitEdit();selectCell(Math.max(0,r-1),c);e.preventDefault();}
    if(e.key==='ArrowDown'&&(!_acDrop||_acDrop.style.display==='none')){commitEdit();selectCell(Math.min(ROWS-1,r+1),c);e.preventDefault();}
    e.stopPropagation();
  });
  inp.addEventListener('blur',function(){
    setTimeout(function(){
      // Never commit while formula cell selection is in progress
      if(_formulaSel) return;
      if(editMode&&_activeR===r&&_activeC===c){hideAc();commitEdit();}
    },200);
  });
}

// ── Selection ─────────────────────────────────────────────────────────────────
function hideOverlay(){var o=document.getElementById('range-overlay');if(o)o.style.display='none';}

// ── Formula-mode selection helpers ────────────────────────────────────────────
function clearFormulaSel(){
  // Visual only — remove classes and hide overlay. Does NOT touch _formulaSel/_formulaSelEnd.
  document.querySelectorAll('.dc.formula-sel').forEach(function(el){el.classList.remove('formula-sel');});
  var fo=document.getElementById('formula-overlay');
  if(fo) fo.style.display='none';
}
function resetFormulaSel(){
  // Full reset — visual + state. Call from commitEdit/cancelEdit only.
  clearFormulaSel();
  _formulaSel=null; _formulaSelEnd=null;
}
// Draw a single dashed blue border around the entire r1,c1→r2,c2 rectangle
function showFormulaSel(r1,c1,r2,c2){
  // Clear per-cell classes
  document.querySelectorAll('.dc.formula-sel').forEach(function(el){el.classList.remove('formula-sel');});
  var fo=document.getElementById('formula-overlay');
  if(!fo) return;
  var tl=document.getElementById('c-'+r1+'-'+c1);
  var br=document.getElementById('c-'+r2+'-'+c2);
  if(!tl||!br){fo.style.display='none';return;}
  var tlr=tl.getBoundingClientRect();
  var brr=br.getBoundingClientRect();
  // Single unified dashed border around entire range using position:fixed
  fo.style.position='fixed';
  fo.style.pointerEvents='none';
  fo.style.zIndex='10';
  fo.style.display='block';
  fo.style.left   = tlr.left+'px';
  fo.style.top    = tlr.top+'px';
  fo.style.width  = (brr.right - tlr.left)+'px';
  fo.style.height = (brr.bottom - tlr.top)+'px';
  fo.style.border = '2px dashed #1565c0';
  fo.style.background = 'rgba(21,101,192,0.07)';
}
function selectCell(r,c){
  hideOverlay();
  var prev=document.getElementById('c-'+selR+'-'+selC);if(prev)prev.classList.remove('sel');
  // Clear col/row header highlights
  var oldCh=document.getElementById('ch-'+selC);if(oldCh)oldCh.classList.remove('col-sel');
  var oldRh=document.getElementById('rh-'+selR);if(oldRh)oldRh.classList.remove('row-sel');
  selR=r;selC=c;
  var cur=document.getElementById('c-'+r+'-'+c);if(cur)cur.classList.add('sel');
  var ch=document.getElementById('ch-'+c);if(ch)ch.classList.add('col-sel');
  var rh=document.getElementById('rh-'+r);if(rh)rh.classList.add('row-sel');
  document.getElementById('cell-addr').value=cellId(r,c);
  document.getElementById('formula-input').value=getRaw(r,c);
  document.getElementById('num-fmt').value=cellFmt[cellId(r,c)]||'';
  document.getElementById('sb-cell').textContent=cellId(r,c);
  updateFmtButtons(r,c);
  updateStatus();
  positionFillHandle(r,c);
}
function updateFmtButtons(r,c){
  var s=cellStyle[cellId(r,c)]||{};
  document.getElementById('btn-bold').classList.toggle('active',!!s.bold);
  document.getElementById('btn-italic').classList.toggle('active',!!s.italic);
  document.getElementById('btn-underline').classList.toggle('active',!!s.underline);
  if(s.fontFamily)document.getElementById('font-family').value=s.fontFamily;
  if(s.fontSize)document.getElementById('font-size').value=s.fontSize;
}
function startSel(r,c,e){rangeStart={r,c};rangeEnd={r,c};clearRange();selectCell(r,c);}
function extSel(r,c,e){
  if(e.buttons!==1||!rangeStart)return;
  rangeEnd={r,c};applyRange();
}
function clearRange(){document.querySelectorAll('.inr').forEach(function(el){el.classList.remove('inr');});document.querySelectorAll('.sel-in-range').forEach(function(el){el.classList.remove('sel-in-range');});hideOverlay();}
function applyRange(){
  clearRange();if(!rangeStart||!rangeEnd)return;
  var r1=Math.min(rangeStart.r,rangeEnd.r),r2=Math.max(rangeStart.r,rangeEnd.r);
  var c1=Math.min(rangeStart.c,rangeEnd.c),c2=Math.max(rangeStart.c,rangeEnd.c);

  // Highlight all cells in range
  for(var r=r1;r<=r2;r++)for(var c=c1;c<=c2;c++){
    var el=document.getElementById('c-'+r+'-'+c);
    if(el) el.classList.add('inr');
  }

  // Single cell — just use the sel outline, no overlay needed
  if(r1===r2&&c1===c2){updateStatus();return;}

  // Multi-cell — hide the sel outline and draw ONE overlay over the entire range
  var selEl=document.getElementById('c-'+selR+'-'+selC);
  if(selEl) selEl.classList.add('sel-in-range'); // suppress outline via CSS

  var tl=document.getElementById('c-'+r1+'-'+c1);
  var br=document.getElementById('c-'+r2+'-'+c2);
  if(!tl||!br){updateStatus();return;}
  var cont=document.getElementById('grid-container');
  var cr=cont.getBoundingClientRect();
  var tlr=tl.getBoundingClientRect();
  var brr=br.getBoundingClientRect();
  var ov=document.getElementById('range-overlay');
  ov.style.display='block';
  ov.style.position='fixed';
  ov.style.left=tlr.left+'px';
  ov.style.top=tlr.top+'px';
  ov.style.width=(brr.right-tlr.left)+'px';
  ov.style.height=(brr.bottom-tlr.top)+'px';
  updateStatus();
}
function updateStatus(){
  var r1=rangeStart?Math.min(rangeStart.r,rangeEnd.r):selR;
  var r2=rangeStart?Math.max(rangeStart.r,rangeEnd.r):selR;
  var c1=rangeStart?Math.min(rangeStart.c,rangeEnd.c):selC;
  var c2=rangeStart?Math.max(rangeStart.c,rangeEnd.c):selC;
  var vals=[];
  for(var r=r1;r<=r2;r++)for(var c=c1;c<=c2;c++){var raw=getRaw(r,c),v=raw&&raw.startsWith('=')?evalFormula(raw):raw,n=parseFloat(v);if(!isNaN(n))vals.push(n);}
  var sum=vals.reduce(function(a,b){return a+b;},0);
  document.getElementById('sb-sum').textContent=vals.length?sum.toFixed(2):0;
  document.getElementById('sb-avg').textContent=vals.length?(sum/vals.length).toFixed(2):0;
  document.getElementById('sb-count').textContent=vals.length;
}

// ── Formula bar ───────────────────────────────────────────────────────────────
var fi=document.getElementById('formula-input');
fi.addEventListener('input',function(){
  createAcElements();
  handleAcInput(fi.value, fi, function(newVal){ fi.value=newVal; });
});
fi.addEventListener('keydown',function(e){
  if(e.key==='Enter'){
    hideAc();setRaw(selR,selC,fi.value);if(selR<ROWS-1)selectCell(selR+1,selC);e.preventDefault();
  }
  if(e.key==='Escape'){hideAc();fi.value=getRaw(selR,selC);fi.blur();}
  if(e.key==='Tab'){hideAc();e.preventDefault();}
});
fi.addEventListener('change',function(){setRaw(selR,selC,fi.value);});

// ── Name Box (cell-addr) — editable, type ref to jump ─────────────────────
var nameBox=document.getElementById('cell-addr');
nameBox.addEventListener('keydown',function(e){
  if(e.key==='Enter'){
    e.preventDefault();
    var raw=nameBox.value.trim().toUpperCase().replace(/\s/g,'');
    if(!raw){nameBox.value=cellId(selR,selC);nameBox.blur();return;}
    // Range ref e.g. A1:D10
    var rangeMatch=raw.match(/^([A-Z]{1,2}\d+):([A-Z]{1,2}\d+)$/);
    if(rangeMatch){
      var s=parseRef(rangeMatch[1]),en=parseRef(rangeMatch[2]);
      if(s&&en){
        var r1=Math.min(s.r,en.r),r2=Math.max(s.r,en.r);
        var c1=Math.min(s.c,en.c),c2=Math.max(s.c,en.c);
        selectCell(r1,c1);
        rangeStart={r:r1,c:c1};rangeEnd={r:r2,c:c2};applyRange();
        nameBox.value=raw;nameBox.blur();return;
      }
    }
    // Single cell ref e.g. B5
    var p=parseRef(raw);
    if(p&&p.r>=0&&p.r<ROWS&&p.c>=0&&p.c<COLS){
      rangeStart=null;rangeEnd=null;clearRange();
      selectCell(p.r,p.c);nameBox.blur();return;
    }
    // Invalid — restore current cell
    nameBox.value=cellId(selR,selC);nameBox.blur();
  }
  if(e.key==='Escape'){
    nameBox.value=cellId(selR,selC);nameBox.blur();
  }
});
// Select all text when user clicks the name box
nameBox.addEventListener('focus',function(){nameBox.select();});

// ── Keyboard ──────────────────────────────────────────────────────────────────
// Helper: find last used row/col for Ctrl+End
function lastUsedCell(){
  var maxR=0,maxC=0;
  Object.keys(data).forEach(function(id){var p=parseRef(id);if(p){maxR=Math.max(maxR,p.r);maxC=Math.max(maxC,p.c);}});
  return{r:maxR,c:maxC};
}
// Helper: Ctrl+Arrow — jump to edge of filled data
function ctrlArrow(dir){
  var r=selR,c=selC;
  var dr=dir==='ArrowUp'?-1:dir==='ArrowDown'?1:0;
  var dc=dir==='ArrowLeft'?-1:dir==='ArrowRight'?1:0;
  var curFilled=getRaw(r,c)!=='';
  if(curFilled){
    // jump to last filled cell in direction, or first empty
    while(true){
      var nr=r+dr,nc=c+dc;
      if(nr<0||nr>=ROWS||nc<0||nc>=COLS)break;
      if(getRaw(nr,nc)==='')break;
      r=nr;c=nc;
    }
  }else{
    // skip empties then jump to first filled
    while(true){
      var nr=r+dr,nc=c+dc;
      if(nr<0||nr>=ROWS||nc<0||nc>=COLS)break;
      r=nr;c=nc;
      if(getRaw(r,c)!=='')break;
    }
  }
  return{r:r,c:c};
}
document.addEventListener('keydown',function(e){
  if(editMode)return;
  if(document.activeElement===fi)return;
  if(document.querySelector('.modal-bg.open'))return;

  var isArrow=e.key==='ArrowUp'||e.key==='ArrowDown'||e.key==='ArrowLeft'||e.key==='ArrowRight';

  // ── Ctrl+Home / Ctrl+End ──────────────────────────────────────────────────
  if((e.ctrlKey||e.metaKey)&&e.key==='Home'){
    rangeStart=null;rangeEnd=null;clearRange();
    selectCell(0,0);e.preventDefault();return;
  }
  if((e.ctrlKey||e.metaKey)&&e.key==='End'){
    rangeStart=null;rangeEnd=null;clearRange();
    var luc=lastUsedCell();selectCell(luc.r,luc.c);e.preventDefault();return;
  }

  // ── Ctrl+Arrow — jump to data edge ───────────────────────────────────────
  if((e.ctrlKey||e.metaKey)&&isArrow){
    rangeStart=null;rangeEnd=null;clearRange();
    var dest=ctrlArrow(e.key);
    selectCell(dest.r,dest.c);e.preventDefault();return;
  }

  // ── Shift+Arrow — extend selection ───────────────────────────────────────
  if(e.shiftKey&&isArrow){
    if(!rangeStart){rangeStart={r:selR,c:selC};rangeEnd={r:selR,c:selC};}
    var d={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]}[e.key];
    rangeEnd={r:Math.max(0,Math.min(ROWS-1,rangeEnd.r+d[0])),c:Math.max(0,Math.min(COLS-1,rangeEnd.c+d[1]))};
    // Move the cursor to rangeEnd without resetting the range
    selR=rangeEnd.r;selC=rangeEnd.c;
    applyRange();
    document.getElementById('cell-addr').value=
      (rangeStart.r===rangeEnd.r&&rangeStart.c===rangeEnd.c)
        ? cellId(selR,selC)
        : cellId(Math.min(rangeStart.r,rangeEnd.r),Math.min(rangeStart.c,rangeEnd.c))+':'+cellId(Math.max(rangeStart.r,rangeEnd.r),Math.max(rangeStart.c,rangeEnd.c));
    e.preventDefault();return;
  }

  // ── Plain Arrow — single cell navigation ─────────────────────────────────
  var nav={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]};
  if(nav[e.key]){
    rangeStart=null;rangeEnd=null;clearRange();
    var d=nav[e.key];
    selectCell(Math.max(0,Math.min(ROWS-1,selR+d[0])),Math.max(0,Math.min(COLS-1,selC+d[1])));
    e.preventDefault();return;
  }

  if(e.key==='F2'){startInlineEdit(selR,selC);return;}
  if(e.key==='Delete'||e.key==='Backspace'){clearCells();return;}
  if((e.ctrlKey||e.metaKey)&&e.key==='z'){doUndo();return;}
  if((e.ctrlKey||e.metaKey)&&e.key==='y'){doRedo();return;}
  if((e.ctrlKey||e.metaKey)&&e.key==='c'){clipCopy();return;}
  if((e.ctrlKey||e.metaKey)&&e.key==='x'){clipCut();return;}
  if((e.ctrlKey||e.metaKey)&&e.key==='v'){clipPaste();return;}
  if((e.ctrlKey||e.metaKey)&&e.key==='f'){doFind();return;}
  if((e.ctrlKey||e.metaKey)&&e.key==='h'){doReplace();return;}
  if(e.key==='PageDown'){selectCell(Math.min(ROWS-1,selR+20),selC);e.preventDefault();return;}
  if(e.key==='PageUp'){selectCell(Math.max(0,selR-20),selC);e.preventDefault();return;}
  if(e.key==='Home'){rangeStart=null;rangeEnd=null;clearRange();selectCell(selR,0);e.preventDefault();return;}
  if(e.key==='End'){rangeStart=null;rangeEnd=null;clearRange();selectCell(selR,COLS-1);e.preventDefault();return;}
  if(e.key==='Escape'){rangeStart=null;rangeEnd=null;clearRange();return;}
  if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey)startInlineEdit(selR,selC,e.key);
});

// ── Clipboard ─────────────────────────────────────────────────────────────────
function clipCopy(){
  var r1=rangeStart?Math.min(rangeStart.r,rangeEnd.r):selR;
  var r2=rangeStart?Math.max(rangeStart.r,rangeEnd.r):selR;
  var c1=rangeStart?Math.min(rangeStart.c,rangeEnd.c):selC;
  var c2=rangeStart?Math.max(rangeStart.c,rangeEnd.c):selC;
  var cells=[];
  for(var r=r1;r<=r2;r++){var row=[];for(var c=c1;c<=c2;c++)row.push(getRaw(r,c));cells.push(row);}
  clipboard={cells,r1,c1,r2,c2};
  document.getElementById('sb-mode').textContent='Copied '+((r2-r1+1)*(c2-c1+1))+' cell(s)';
}
function clipCut(){clipCopy();clearCells();document.getElementById('sb-mode').textContent='Cut';}
function clipPaste(){
  if(!clipboard)return;
  var cells=clipboard.cells;
  for(var dr=0;dr<cells.length;dr++)for(var dc=0;dc<cells[dr].length;dc++)setRaw(selR+dr,selC+dc,cells[dr][dc]);
  document.getElementById('sb-mode').textContent='Pasted';
}

// ── Formatting ────────────────────────────────────────────────────────────────
function fmt(type){
  var r1=rangeStart?Math.min(rangeStart.r,rangeEnd.r):selR;
  var r2=rangeStart?Math.max(rangeStart.r,rangeEnd.r):selR;
  var c1=rangeStart?Math.min(rangeStart.c,rangeEnd.c):selC;
  var c2=rangeStart?Math.max(rangeStart.c,rangeEnd.c):selC;
  var id=cellId(selR,selC);if(!cellStyle[id])cellStyle[id]={};
  var newVal=!cellStyle[id][type];
  for(var r=r1;r<=r2;r++)for(var c=c1;c<=c2;c++){
    var cid=cellId(r,c);if(!cellStyle[cid])cellStyle[cid]={};
    cellStyle[cid][type]=newVal;renderCell(r,c);
  }
  updateFmtButtons(selR,selC);markUnsaved();
}
function setAlign(a){
  var r1=rangeStart?Math.min(rangeStart.r,rangeEnd.r):selR;
  var r2=rangeStart?Math.max(rangeStart.r,rangeEnd.r):selR;
  var c1=rangeStart?Math.min(rangeStart.c,rangeEnd.c):selC;
  var c2=rangeStart?Math.max(rangeStart.c,rangeEnd.c):selC;
  for(var r=r1;r<=r2;r++)for(var c=c1;c<=c2;c++){var cid=cellId(r,c);if(!cellStyle[cid])cellStyle[cid]={};cellStyle[cid].align=a;renderCell(r,c);}
  markUnsaved();
}
function applyFont(){var f=document.getElementById('font-family').value;applyStyleProp('fontFamily',f);}
function applyFontSize(){var s=parseInt(document.getElementById('font-size').value);applyStyleProp('fontSize',s);}
function applyStyleProp(prop,val){
  var r1=rangeStart?Math.min(rangeStart.r,rangeEnd.r):selR;
  var r2=rangeStart?Math.max(rangeStart.r,rangeEnd.r):selR;
  var c1=rangeStart?Math.min(rangeStart.c,rangeEnd.c):selC;
  var c2=rangeStart?Math.max(rangeStart.c,rangeEnd.c):selC;
  for(var r=r1;r<=r2;r++)for(var c=c1;c<=c2;c++){var cid=cellId(r,c);if(!cellStyle[cid])cellStyle[cid]={};cellStyle[cid][prop]=val;renderCell(r,c);}
  markUnsaved();
}
function applyNumFmt(f){
  var r1=rangeStart?Math.min(rangeStart.r,rangeEnd.r):selR;
  var r2=rangeStart?Math.max(rangeStart.r,rangeEnd.r):selR;
  var c1=rangeStart?Math.min(rangeStart.c,rangeEnd.c):selC;
  var c2=rangeStart?Math.max(rangeStart.c,rangeEnd.c):selC;
  for(var r=r1;r<=r2;r++)for(var c=c1;c<=c2;c++){cellFmt[cellId(r,c)]=f;renderCell(r,c);}
  markUnsaved();
}
function incDecimal(dir){
  var id=cellId(selR,selC);var raw=getRaw(selR,selC);
  if(!isNaN(parseFloat(raw))){
    var n=parseFloat(raw),dec=(n.toString().split('.')[1]||'').length;
    var newDec=Math.max(0,dec+dir);
    setRaw(selR,selC,n.toFixed(newDec));
  }
}
// ── Font size dropdown ────────────────────────────────────────────────────────
var _fontSizeMenuEl = null;
var _fontSizeMenuAnchor = null;
function toggleFontSizeMenu(anchorEl){
  if(_fontSizeMenuEl){_fontSizeMenuEl.remove();_fontSizeMenuEl=null;document.removeEventListener('mousedown',_closeFontSizeMenu,true);return;}
  _fontSizeMenuAnchor=anchorEl;
  var sizes=[6,7,8,9,10,11,12,14,16,18,20,22,24,28,32,36,48,72];
  var m=document.createElement('div');
  m.style.cssText='position:fixed;background:#fff;border:1px solid #ccc;border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:99999;width:60px;max-height:200px;overflow-y:auto;padding:3px 0';
  sizes.forEach(function(sz){
    var d=document.createElement('div');
    d.style.cssText='padding:4px 12px;font-size:11px;cursor:pointer;color:#222;text-align:center';
    d.textContent=sz;
    d.onmouseenter=function(){d.style.background='#e8f5ed';d.style.color='#1e6e3a'};
    d.onmouseleave=function(){d.style.background='';d.style.color='#222'};
    d.onmousedown=function(e){
      e.preventDefault();
      document.getElementById('font-size').value=sz;
      applyFontSize();
      _fontSizeMenuEl.remove();_fontSizeMenuEl=null;
      document.removeEventListener('mousedown',_closeFontSizeMenu,true);
    };
    m.appendChild(d);
  });
  document.body.appendChild(m);
  _fontSizeMenuEl=m;
  var rect=anchorEl.getBoundingClientRect();
  var top=rect.bottom+2; var left=rect.left;
  if(top+204>window.innerHeight)top=rect.top-206;
  m.style.left=left+'px'; m.style.top=top+'px';
  setTimeout(function(){document.addEventListener('mousedown',_closeFontSizeMenu,true);},0);
}
function _closeFontSizeMenu(e){
  if(e.target===_fontSizeMenuAnchor)return;
  if(_fontSizeMenuEl&&!_fontSizeMenuEl.contains(e.target)){
    _fontSizeMenuEl.remove();_fontSizeMenuEl=null;
    document.removeEventListener('mousedown',_closeFontSizeMenu,true);
  }
}
// ── Sort dropdown menu ────────────────────────────────────────────────────────
var _sortMenuEl = null;
var _sortMenuAnchor = null;
function toggleSortMenu(anchorEl){
  if(_sortMenuEl){_sortMenuEl.remove();_sortMenuEl=null;document.removeEventListener('mousedown',_closeSortMenu,true);return;}
  _sortMenuAnchor=anchorEl;
  var items=[
    {label:'A → Z  (Ascending)',  fn:function(){doSort(true);}},
    {label:'Z → A  (Descending)', fn:function(){doSort(false);}},
    {label:'Smallest to Largest', fn:function(){doSortNumeric(true);}},
    {label:'Largest to Smallest', fn:function(){doSortNumeric(false);}},
    {label:'Custom Sort…',        fn:function(){openModal('modal-customsort');}}
  ];
  var m=document.createElement('div');
  m.style.cssText='position:fixed;background:#fff;border:1px solid #ccc;border-radius:4px;box-shadow:0 4px 14px rgba(0,0,0,0.18);z-index:99999;width:190px;padding:3px 0';
  items.forEach(function(it){
    var d=document.createElement('div');
    d.style.cssText='padding:5px 14px;font-size:11px;cursor:pointer;color:#222';
    d.textContent=it.label;
    d.onmouseenter=function(){d.style.background='#e8f5ed';d.style.color='#1e6e3a'};
    d.onmouseleave=function(){d.style.background='';d.style.color='#222'};
    d.onmousedown=function(e){
      e.preventDefault();
      _sortMenuEl.remove();_sortMenuEl=null;
      document.removeEventListener('mousedown',_closeSortMenu,true);
      it.fn();
    };
    m.appendChild(d);
  });
  document.body.appendChild(m);
  _sortMenuEl=m;
  var rect=anchorEl.getBoundingClientRect();
  var top=rect.bottom+2; var left=rect.left;
  if(left+194>window.innerWidth)left=window.innerWidth-196;
  if(top+160>window.innerHeight)top=rect.top-162;
  m.style.left=left+'px'; m.style.top=top+'px';
  setTimeout(function(){document.addEventListener('mousedown',_closeSortMenu,true);},0);
}
function _closeSortMenu(e){
  if(e.target===_sortMenuAnchor)return;
  if(_sortMenuEl&&!_sortMenuEl.contains(e.target)){
    _sortMenuEl.remove();_sortMenuEl=null;
    document.removeEventListener('mousedown',_closeSortMenu,true);
  }
}
function doSortNumeric(asc){
  var c=selC;
  var rows=Array.from({length:ROWS},function(_,r){
    return Array.from({length:COLS},function(_,cc){return getRaw(r,cc);});
  });
  rows.sort(function(a,b){
    var av=parseFloat(a[c]),bv=parseFloat(b[c]);
    var aNum=!isNaN(av),bNum=!isNaN(bv);
    if(aNum&&bNum)return asc?av-bv:bv-av;
    if(aNum)return -1;
    if(bNum)return 1;
    return 0;
  });
  rows.forEach(function(row,r){
    row.forEach(function(v,cc){if(v)data[cellId(r,cc)]=v;else delete data[cellId(r,cc)];});
  });
  renderAll();markUnsaved();
}

var _pasteMenuEl = null;
var _pasteMenuAnchor = null;
function togglePasteMenu(anchorEl){
  if(_pasteMenuEl){_pasteMenuEl.remove();_pasteMenuEl=null;document.removeEventListener('mousedown',_closePasteMenu,true);return;}
  _pasteMenuAnchor=anchorEl;
  var m=document.createElement('div');
  m.style.cssText='position:fixed;background:#fff;border:1px solid #ccc;border-radius:4px;box-shadow:0 4px 14px rgba(0,0,0,0.18);z-index:99999;width:170px;padding:3px 0';
  var items=[
    {label:'Paste',fn:'clipPaste()'},
    {label:'Paste as Picture',fn:'pasteAsPicture()'},
    {label:'Paste Special…',fn:'pasteSpecial()'}
  ];
  items.forEach(function(it){
    var d=document.createElement('div');
    d.style.cssText='padding:5px 14px;font-size:11px;cursor:pointer;color:#222';
    d.textContent=it.label;
    d.onmouseenter=function(){d.style.background='#e8f5ed';d.style.color='#1e6e3a'};
    d.onmouseleave=function(){d.style.background='';d.style.color='#222'};
    d.onmousedown=function(e){e.preventDefault();_pasteMenuEl.remove();_pasteMenuEl=null;document.removeEventListener('mousedown',_closePasteMenu,true);eval(it.fn);};
    m.appendChild(d);
  });
  document.body.appendChild(m);
  _pasteMenuEl=m;
  var rect=anchorEl.getBoundingClientRect();
  var top=rect.bottom+2; var left=rect.left;
  if(left+174>window.innerWidth)left=window.innerWidth-176;
  if(top+120>window.innerHeight)top=rect.top-122;
  m.style.left=left+'px'; m.style.top=top+'px';
  setTimeout(function(){document.addEventListener('mousedown',_closePasteMenu,true);},0);
}
function _closePasteMenu(e){
  if(e.target===_pasteMenuAnchor)return;
  if(_pasteMenuEl&&!_pasteMenuEl.contains(e.target)){
    _pasteMenuEl.remove();_pasteMenuEl=null;
    document.removeEventListener('mousedown',_closePasteMenu,true);
  }
}
function pasteAsPicture(){alert('Paste as Picture: pastes clipboard image into sheet (coming soon).');}
function pasteSpecial(){openModal('modal-find');} // reuse find modal as placeholder

var _copyMenuAnchor = null;
function toggleCopyMenu(anchorEl){
  if(_copyMenuEl){_copyMenuEl.remove();_copyMenuEl=null;document.removeEventListener('mousedown',_closeCopyMenu,true);return;}
  _copyMenuAnchor=anchorEl;
  var m=document.createElement('div');
  m.style.cssText='position:fixed;background:#fff;border:1px solid #ccc;border-radius:4px;box-shadow:0 4px 14px rgba(0,0,0,0.18);z-index:99999;width:170px;padding:3px 0';
  var items=[
    {label:'Copy',fn:'clipCopy()'},
    {label:'Copy as Picture',fn:'copyAsPicture()'}
  ];
  items.forEach(function(it){
    var d=document.createElement('div');
    d.style.cssText='padding:5px 14px;font-size:11px;cursor:pointer;color:#222';
    d.textContent=it.label;
    d.onmouseenter=function(){d.style.background='#e8f5ed';d.style.color='#1e6e3a'};
    d.onmouseleave=function(){d.style.background='';d.style.color='#222'};
    d.onmousedown=function(e){e.preventDefault();_copyMenuEl.remove();_copyMenuEl=null;document.removeEventListener('mousedown',_closeCopyMenu,true);eval(it.fn);};
    m.appendChild(d);
  });
  document.body.appendChild(m);
  _copyMenuEl=m;
  var rect=anchorEl.getBoundingClientRect();
  var top=rect.bottom+2; var left=rect.left;
  if(left+174>window.innerWidth)left=window.innerWidth-176;
  if(top+80>window.innerHeight)top=rect.top-82;
  m.style.left=left+'px'; m.style.top=top+'px';
  setTimeout(function(){document.addEventListener('mousedown',_closeCopyMenu,true);},0);
}
function _closeCopyMenu(e){
  if(e.target===_copyMenuAnchor)return;
  if(_copyMenuEl&&!_copyMenuEl.contains(e.target)){
    _copyMenuEl.remove();_copyMenuEl=null;
    document.removeEventListener('mousedown',_closeCopyMenu,true);
  }
}
function copyAsPicture(){alert('Copy as Picture: copies selection as image to clipboard (coming soon).');}

// ── Text Orientation dropdown ────────────────────────────────────────────────
function toggleOrientMenu(anchorEl){
  var drop=document.getElementById('orient-drop');
  if(!drop)return;
  if(drop.classList.contains('open')){closeOrientMenu();return;}
  var rect=anchorEl.closest('.orient-wrap').getBoundingClientRect();
  var top=rect.bottom+2; var left=rect.left;
  if(left+200>window.innerWidth)left=window.innerWidth-202;
  if(top+200>window.innerHeight)top=rect.top-202;
  drop.style.top=top+'px'; drop.style.left=left+'px';
  drop.classList.add('open');
  setTimeout(function(){document.addEventListener('mousedown',_closeOrientOutside,true);},0);
}
function closeOrientMenu(){
  var drop=document.getElementById('orient-drop');
  if(drop){drop.classList.remove('open');drop.style.top='';drop.style.left='';}
  document.removeEventListener('mousedown',_closeOrientOutside,true);
}
function _closeOrientOutside(e){
  var drop=document.getElementById('orient-drop');
  if(drop&&!drop.contains(e.target)&&!e.target.closest('.orient-wrap')){closeOrientMenu();}
}
function setTextOrientation(dir){
  var id=cellId(selR,selC);
  if(!cellStyle[id])cellStyle[id]={};
  var css='';
  if(dir==='ccw')css='writing-mode:horizontal-tb;transform:rotate(-45deg)';
  else if(dir==='cw')css='writing-mode:horizontal-tb;transform:rotate(45deg)';
  else if(dir==='vertical')css='writing-mode:vertical-rl;text-orientation:upright';
  else if(dir==='up')css='writing-mode:vertical-rl;transform:rotate(180deg)';
  else if(dir==='down')css='writing-mode:vertical-lr';
  cellStyle[id].orientation=css;
  renderCell(selR,selC);
  markUnsaved();
}

// ── Indent ───────────────────────────────────────────────────────────────────
function setIndent(delta){
  var r1=rangeStart.r,c1=rangeStart.c,r2=rangeEnd.r,c2=rangeEnd.c;
  if(r2<r1){var t=r1;r1=r2;r2=t;} if(c2<c1){var t=c1;c1=c2;c2=t;}
  for(var r=r1;r<=r2;r++) for(var c=c1;c<=c2;c++){
    var id=cellId(r,c); if(!cellStyle[id])cellStyle[id]={};
    var cur=parseInt(cellStyle[id].indent)||0;
    cellStyle[id].indent=Math.max(0,cur+delta);
    renderCell(r,c);
  }
  markUnsaved();
}

// ── Comma format ─────────────────────────────────────────────────────────────
function applyCommaFormat(){
  applyNumFmt('number');
}
var _colorPickerTarget = null; // 'font' or 'fill'
var _colorPickerEl     = null;
var _lastFontColor     = '#000000';
var _lastFillColor     = '#ffff00';

// Theme grid: 10 hue columns x 6 intensity rows (light→dark)
// Each column: [tint80, tint60, tint40, base, shade25, shade50]
var COLOR_THEME_COLS = [
  // White/Black
  ['#ffffff','#d9d9d9','#b3b3b3','#808080','#404040','#000000'],
  // Brown/Tan
  ['#f5e6d3','#e8c9a0','#d4a96a','#a0522d','#6b3920','#3d1f0e'],
  // Red
  ['#ffd7d5','#ffaaaa','#ff7f7f','#e53935','#b71c1c','#6a0000'],
  // Orange
  ['#ffe5c8','#ffcc99','#ffb166','#f57c00','#bf360c','#7f2300'],
  // Yellow
  ['#fff9c4','#fff176','#ffee58','#fbc02d','#f57f17','#a35200'],
  // Lime/Yellow-green
  ['#f0f7da','#d4edaa','#b5dd72','#8bc34a','#558b2f','#2e5c12'],
  // Green
  ['#c8e6c9','#a5d6a7','#66bb6a','#2e7d32','#1b5e20','#0a2e0c'],
  // Teal
  ['#b2dfdb','#80cbc4','#4db6ac','#00796b','#004d40','#002923'],
  // Blue
  ['#bbdefb','#90caf9','#64b5f6','#1976d2','#0d47a1','#042060'],
  // Purple
  ['#e1bee7','#ce93d8','#ba68c8','#7b1fa2','#4a148c','#260057']
];

// Standard row: 10 fixed bold colors
var COLOR_STANDARD = [
  '#c00000','#ff0000','#ff6600','#ffff00','#92d050',
  '#00b050','#00b0f0','#0070c0','#7030a0','#ff007f'
];

function updateColorBar(target, hex){
  var barId = target === 'font' ? 'font-color-bar' : 'fill-color-bar';
  var bar = document.getElementById(barId);
  if(bar) bar.style.background = hex || (target === 'font' ? '#000000' : 'transparent');
}

function applyLastFontColor(){
  applyStyleProp('color', _lastFontColor);
}
function applyLastFillColor(){
  applyStyleProp('bg', _lastFillColor);
}
function openFontColorPicker(arrowEl){
  if(_colorPickerEl && _colorPickerTarget==='font'){ closeColorPicker(); return; }
  showColorPicker(arrowEl, 'font');
}
function openFillColorPicker(arrowEl){
  if(_colorPickerEl && _colorPickerTarget==='fill'){ closeColorPicker(); return; }
  showColorPicker(arrowEl, 'fill');
}
// Keep old names as aliases (used elsewhere)
function openFontColor(btnEl){ showColorPicker(btnEl, 'font'); }
function openFillColor(btnEl){ showColorPicker(btnEl, 'fill'); }

function showColorPicker(anchorEl, target){
  closeColorPicker();
  _colorPickerTarget = target;

  var picker = document.createElement('div');
  picker.id = 'color-picker-popup';
  picker.style.cssText = 'position:fixed;background:#fff;border:1px solid #ccc;border-radius:6px;box-shadow:0 4px 18px rgba(0,0,0,0.24);z-index:99999;padding:10px 10px 8px;width:214px;user-select:none';

  // Title
  var title = document.createElement('div');
  title.style.cssText = 'font-size:10px;font-weight:700;color:#555;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em';
  title.textContent = target === 'font' ? 'Font Color' : 'Fill Color';
  picker.appendChild(title);

  // ── Theme Colors section ──────────────────────────────────────────────────
  var themeLabel = document.createElement('div');
  themeLabel.style.cssText = 'font-size:9px;color:#888;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px';
  themeLabel.textContent = 'Theme Colors';
  picker.appendChild(themeLabel);

  // Grid: columns = hues, rows = intensity
  // Render column by column, but display as CSS grid row-major
  // We have 10 cols x 6 rows = 60 swatches; lay out row-major
  var themeGrid = document.createElement('div');
  themeGrid.style.cssText = 'display:grid;grid-template-columns:repeat(10,18px);grid-template-rows:repeat(6,14px);gap:1px;margin-bottom:6px';

  // Build row-major: row 0 = top intensity of each col, row 5 = darkest
  for(var row = 0; row < 6; row++){
    for(var col = 0; col < 10; col++){
      (function(hex, r, c){
        var sw = document.createElement('div');
        sw.style.cssText = 'width:18px;height:14px;border-radius:'+(r===0?'2px 2px 0 0':r===5?'0 0 2px 2px':'0')+';cursor:pointer;background:'+hex+';border:0.5px solid rgba(0,0,0,0.12);box-sizing:border-box';
        sw.title = hex;
        sw.addEventListener('mouseenter', function(){sw.style.transform='scale(1.3)';sw.style.zIndex='5';sw.style.position='relative';});
        sw.addEventListener('mouseleave', function(){sw.style.transform='';sw.style.zIndex='';sw.style.position='';});
        sw.addEventListener('mousedown', function(e){e.preventDefault();applyColorPickerValue(hex);});
        themeGrid.appendChild(sw);
      })(COLOR_THEME_COLS[col][row], row, col);
    }
  }
  picker.appendChild(themeGrid);

  // ── Standard Colors section ───────────────────────────────────────────────
  var stdLabel = document.createElement('div');
  stdLabel.style.cssText = 'font-size:9px;color:#888;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px';
  stdLabel.textContent = 'Standard Colors';
  picker.appendChild(stdLabel);

  var stdGrid = document.createElement('div');
  stdGrid.style.cssText = 'display:grid;grid-template-columns:repeat(10,18px);gap:1px;margin-bottom:8px';
  COLOR_STANDARD.forEach(function(hex){
    var sw = document.createElement('div');
    sw.style.cssText = 'width:18px;height:16px;border-radius:2px;cursor:pointer;background:'+hex+';border:0.5px solid rgba(0,0,0,0.15);box-sizing:border-box';
    sw.title = hex;
    sw.addEventListener('mouseenter', function(){sw.style.transform='scale(1.25)';sw.style.zIndex='5';sw.style.position='relative';});
    sw.addEventListener('mouseleave', function(){sw.style.transform='';sw.style.zIndex='';sw.style.position='';});
    sw.addEventListener('mousedown', function(e){e.preventDefault();applyColorPickerValue(hex);});
    stdGrid.appendChild(sw);
  });
  picker.appendChild(stdGrid);

  // ── Divider ───────────────────────────────────────────────────────────────
  var divider = document.createElement('div');
  divider.style.cssText = 'border-top:1px solid #eee;margin:0 0 7px';
  picker.appendChild(divider);

  // ── Custom color row ──────────────────────────────────────────────────────
  var customRow = document.createElement('div');
  customRow.style.cssText = 'display:flex;align-items:center;gap:5px';

  var noneBtn = document.createElement('button');
  noneBtn.textContent = '✕ None';
  noneBtn.style.cssText = 'padding:3px 7px;font-size:10px;background:#f5f5f5;color:#333;border:1px solid #ccc;border-radius:3px;cursor:pointer;white-space:nowrap';
  noneBtn.addEventListener('mousedown', function(e){e.preventDefault();applyColorPickerValue('');});

  var customInput = document.createElement('input');
  customInput.type = 'color';
  customInput.value = target === 'font' ? (_lastFontColor || '#000000') : (_lastFillColor || '#ffff00');
  customInput.style.cssText = 'width:28px;height:24px;border:1px solid #ccc;border-radius:3px;cursor:pointer;padding:1px;margin-left:auto';
  customInput.title = 'Custom color';
  customInput.addEventListener('change', function(){applyColorPickerValue(customInput.value);});

  var customLabel2 = document.createElement('span');
  customLabel2.style.cssText = 'font-size:10px;color:#555;white-space:nowrap';
  customLabel2.textContent = 'Custom';

  customRow.appendChild(noneBtn);
  customRow.appendChild(customLabel2);
  customRow.appendChild(customInput);
  picker.appendChild(customRow);

  document.body.appendChild(picker);
  _colorPickerEl = picker;

  // Position below anchor
  var rect = anchorEl ? anchorEl.getBoundingClientRect() : {left:200, bottom:80, top:80};
  var left = rect.left;
  var top  = rect.bottom + 4;
  if(left + 220 > window.innerWidth)  left = window.innerWidth - 222;
  if(top  + 310 > window.innerHeight) top  = rect.top - 314;
  picker.style.left = left + 'px';
  picker.style.top  = top  + 'px';

  setTimeout(function(){
    document.addEventListener('mousedown', _colorPickerOutside, true);
  }, 0);
}

function _colorPickerOutside(e){
  if(_colorPickerEl && !_colorPickerEl.contains(e.target)){
    closeColorPicker();
  }
}

function closeColorPicker(){
  if(_colorPickerEl){ _colorPickerEl.remove(); _colorPickerEl = null; }
  document.removeEventListener('mousedown', _colorPickerOutside, true);
}

function applyColorPickerValue(hex){
  if(_colorPickerTarget === 'font'){
    applyStyleProp('color', hex);
    if(hex){ _lastFontColor = hex; updateColorBar('font', hex); }
    else { updateColorBar('font', '#000000'); }
  } else {
    applyStyleProp('bg', hex);
    if(hex){ _lastFillColor = hex; updateColorBar('fill', hex); }
    else { updateColorBar('fill', 'transparent'); }
  }
  closeColorPicker();
}
function applyStyle(type){
  var colors={good:{bg:'#e8f5e9',color:'#1e6e3a'},bad:{bg:'#ffebee',color:'#c0392b'},neutral:{bg:'#fff8e1',color:'#f57f17'}};
  var s=colors[type];
  applyStyleProp('bg',s.bg);applyStyleProp('color',s.color);
}
function condFormat(){
  var threshold=prompt('Highlight cells greater than:','0');if(threshold===null)return;
  var t=parseFloat(threshold);
  for(var r=0;r<ROWS;r++)for(var c=0;c<COLS;c++){
    var raw=getRaw(r,c),n=parseFloat(raw&&raw.startsWith('=')?evalFormula(raw):raw);
    if(!isNaN(n)&&n>t){var cid=cellId(r,c);if(!cellStyle[cid])cellStyle[cid]={};cellStyle[cid].bg='#fff9c4';renderCell(r,c);}
  }
}
function mergeToggle(){alert('Merge: Select a range, then use this to visually merge. Data from top-left cell is kept.');}
function wrapToggle(){
  var id=cellId(selR,selC);if(!cellStyle[id])cellStyle[id]={};
  cellStyle[id].wrap=!cellStyle[id].wrap;renderCell(selR,selC);
}
function setVAlign(v){
  var r1=rangeStart.r,c1=rangeStart.c,r2=rangeEnd.r,c2=rangeEnd.c;
  if(r2<r1){var t=r1;r1=r2;r2=t;}if(c2<c1){var t=c1;c1=c2;c2=t;}
  for(var r=r1;r<=r2;r++)for(var c=c1;c<=c2;c++){
    var id=cellId(r,c);if(!cellStyle[id])cellStyle[id]={};
    cellStyle[id].valign=v;renderCell(r,c);
  }
  markUnsaved();
}

// ── Rows & Columns ────────────────────────────────────────────────────────────
function insertRowAbove(){
  for(var r=ROWS-1;r>selR;r--)for(var c=0;c<COLS;c++){var v=getRaw(r-1,c);if(v)data[cellId(r,c)]=v;else delete data[cellId(r,c)];}
  for(var c=0;c<COLS;c++)delete data[cellId(selR,c)];
  renderAll();markUnsaved();
}
function deleteSelectedRow(){
  for(var r=selR;r<ROWS-1;r++)for(var c=0;c<COLS;c++){var v=getRaw(r+1,c);if(v)data[cellId(r,c)]=v;else delete data[cellId(r,c)];}
  for(var c=0;c<COLS;c++)delete data[cellId(ROWS-1,c)];
  renderAll();markUnsaved();
}
function insertColLeft(){
  for(var c=COLS-1;c>selC;c--)for(var r=0;r<ROWS;r++){var v=getRaw(r,c-1);if(v)data[cellId(r,c)]=v;else delete data[cellId(r,c)];}
  for(var r=0;r<ROWS;r++)delete data[cellId(r,selC)];
  renderAll();markUnsaved();
}
function deleteSelectedCol(){
  for(var c=selC;c<COLS-1;c++)for(var r=0;r<ROWS;r++){var v=getRaw(r,c+1);if(v)data[cellId(r,c)]=v;else delete data[cellId(r,c)];}
  for(var r=0;r<ROWS;r++)delete data[cellId(r,COLS-1)];
  renderAll();markUnsaved();
}
function clearCells(){
  var r1=rangeStart?Math.min(rangeStart.r,rangeEnd.r):selR;
  var r2=rangeStart?Math.max(rangeStart.r,rangeEnd.r):selR;
  var c1=rangeStart?Math.min(rangeStart.c,rangeEnd.c):selC;
  var c2=rangeStart?Math.max(rangeStart.c,rangeEnd.c):selC;
  for(var r=r1;r<=r2;r++)for(var c=c1;c<=c2;c++)setRaw(r,c,'');
  fi.value='';
}

// ── Table & Formulas ──────────────────────────────────────────────────────────
function createTable(){
  var r1=rangeStart?Math.min(rangeStart.r,rangeEnd.r):selR;
  var r2=rangeStart?Math.max(rangeStart.r,rangeEnd.r):Math.min(selR+4,ROWS-1);
  var c1=rangeStart?Math.min(rangeStart.c,rangeEnd.c):selC;
  var c2=rangeStart?Math.max(rangeStart.c,rangeEnd.c):Math.min(selC+3,COLS-1);

  // Header row — green background, white bold text
  for(var c=c1;c<=c2;c++){
    var id=cellId(r1,c);
    if(!cellStyle[id])cellStyle[id]={};
    cellStyle[id].bg='#1e6e3a';
    cellStyle[id].color='#ffffff';
    cellStyle[id].bold=true;
    // Add default header text only if cell is empty
    if(!getRaw(r1,c))setRaw(r1,c,'Column '+(c-c1+1));
    renderCell(r1,c);
  }

  // Data rows — alternating light-green tint on every other row
  // Row index relative to table: 0=header, 1=first data row, 2=second ...
  // Alt rows are data rows at relative index 1,3,5... (odd relative index)
  for(var r=r1+1;r<=r2;r++){
    var isAlt=((r-r1)%2===1); // r1+1 → rel 1 → alt, r1+2 → rel 2 → plain, etc.
    for(var c=c1;c<=c2;c++){
      var id=cellId(r,c);
      if(!cellStyle[id])cellStyle[id]={};
      if(isAlt){
        cellStyle[id].bg='#e8f5e9';
      }else{
        // Plain rows: only clear if previously set by table (don't wipe user colour)
        if(cellStyle[id].bg==='#e8f5e9'||cellStyle[id].bg==='#f0f9f3')
          delete cellStyle[id].bg;
      }
      renderCell(r,c);
    }
  }

  markUnsaved();
  document.getElementById('sb-mode').textContent=
    'Table created: '+cellId(r1,c1)+':'+cellId(r2,c2);
}
function insertAutoSum(){var s='=SUM('+cellId(Math.max(0,selR-5),selC)+':'+cellId(selR-1,selC)+')';setRaw(selR,selC,s);fi.value=s;}
// ── Formula Category Dropdowns ────────────────────────────────────────────────
var _openFng = null;
function toggleFng(id){
  var drop = document.getElementById('fnd-'+id);
  var box  = document.getElementById('fng-'+id).querySelector('.fng-box');
  if(_openFng && _openFng !== id){
    var prev = document.getElementById('fnd-'+_openFng);
    if(prev){ prev.classList.remove('open'); prev.style.cssText=''; }
  }
  var isOpen = drop.classList.contains('open');
  if(isOpen){
    drop.classList.remove('open');
    drop.style.cssText='';
    _openFng=null;
  } else {
    var rect = box.getBoundingClientRect();
    var top  = rect.bottom + 2;
    var left = rect.left;
    if(left + 164 > window.innerWidth) left = window.innerWidth - 166;
    if(top  + 264 > window.innerHeight) top = rect.top - 266;
    drop.style.cssText='display:block;top:'+top+'px;left:'+left+'px';
    drop.classList.add('open');
    _openFng=id;
  }
}
document.addEventListener('mousedown', function(e){
  if(_openFng && !e.target.closest('.fng')){
    var prev=document.getElementById('fnd-'+_openFng);
    if(prev){prev.classList.remove('open');prev.style.cssText='';}
    _openFng=null;
  }
}, true);

function insertFn(fn){
  if(_openFng){
    var prev=document.getElementById('fnd-'+_openFng);
    if(prev){prev.classList.remove('open');prev.style.cssText='';}
    _openFng=null;
  }
  closeModal('modal-formula');
  fi.value='='+fn+'(';fi.focus();
}

// ── Sort & Filter ─────────────────────────────────────────────────────────────
function doSort(asc){
  var c=selC;
  var rows=Array.from({length:ROWS},function(_,r){return Array.from({length:COLS},function(_,cc){return getRaw(r,cc);});});
  rows.sort(function(a,b){
    var av=parseFloat(a[c]),bv=parseFloat(b[c]);
    if(!isNaN(av)&&!isNaN(bv))return asc?av-bv:bv-av;
    return asc?String(a[c]).localeCompare(String(b[c])):String(b[c]).localeCompare(String(a[c]));
  });
  rows.forEach(function(row,r){row.forEach(function(v,cc){if(v)data[cellId(r,cc)]=v;else delete data[cellId(r,cc)];});});
  renderAll();markUnsaved();
}
function toggleFilter(){
  filterActive=!filterActive;
  document.getElementById('btn-filter').classList.toggle('active',filterActive);
  document.getElementById('sb-mode').textContent=filterActive?'Filter ON':'Ready';
  if(filterActive){var val=prompt('Show rows where column '+colName(selC)+' contains:');if(val){filterCol(selC,val);}else{filterActive=false;document.getElementById('btn-filter').classList.remove('active');}}
}
function filterCol(c,val){
  for(var r=1;r<ROWS;r++){
    var row=document.querySelector('tbody tr:nth-child('+(r+1)+')');
    if(row){var cv=getRaw(r,c);row.style.display=cv.toLowerCase().includes(val.toLowerCase())?'':'none';}
  }
}
function clearFilter(){
  filterActive=false;document.getElementById('btn-filter').classList.remove('active');
  document.querySelectorAll('tbody tr').forEach(function(tr){tr.style.display='';});
  document.getElementById('sb-mode').textContent='Ready';
}
function highlightDuplicates(){
  var counts={};
  for(var r=0;r<ROWS;r++){var v=getRaw(r,selC);if(v){counts[v]=(counts[v]||0)+1;}}
  for(var r=0;r<ROWS;r++){var v=getRaw(r,selC);if(v&&counts[v]>1){var cid=cellId(r,selC);if(!cellStyle[cid])cellStyle[cid]={};cellStyle[cid].bg='#fff176';renderCell(r,selC);}}
  document.getElementById('sb-mode').textContent='Duplicates highlighted';
}
function removeDuplicates(){
  var seen=new Set();
  for(var r=0;r<ROWS;r++){
    var key=Array.from({length:COLS},function(_,c){return getRaw(r,c);}).join('|');
    if(seen.has(key))for(var c=0;c<COLS;c++)delete data[cellId(r,c)];
    else seen.add(key);
  }
  renderAll();markUnsaved();
}
function textToColumns(){
  var delim=prompt('Delimiter (e.g. , or ; or space):',',');if(!delim)return;
  var raw=getRaw(selR,selC);if(!raw)return;
  var parts=raw.split(delim);
  parts.forEach(function(p,i){if(selC+i<COLS)setRaw(selR,selC+i,p.trim());});
}
function populateSortCols(){
  var sel=document.getElementById('sort-col');if(!sel)return;
  sel.innerHTML='';
  for(var c=0;c<COLS;c++){var opt=document.createElement('option');opt.value=c;opt.textContent='Column '+colName(c);sel.appendChild(opt);}
}
function applyCustomSort(){
  var c=parseInt(document.getElementById('sort-col').value);
  var asc=document.getElementById('sort-order').value==='asc';
  var origSelC=selC;selC=c;doSort(asc);selC=origSelC;
  closeModal('modal-customsort');
}
function applyDataVal(){
  var type=document.getElementById('val-type').value;
  var val=document.getElementById('val-value').value;
  var msg=document.getElementById('val-msg').value||'Invalid input';
  dataValidation[cellId(selR,selC)]={type,val,msg};
  // If type is 'list', attach a dropdown to the cell
  if(type==='list'){
    attachDropdownValidation(selR,selC,val.split(',').map(function(v){return v.trim();}));
  }
  closeModal('modal-dataval');
  document.getElementById('sb-mode').textContent='Validation set for '+cellId(selR,selC);
}
function openDataValModal(){openModal('modal-dataval');}

// ── In-cell Dropdown Validation ───────────────────────────────────────────────
var _dropdownValidations = {}; // cellId -> [list of values]

function attachDropdownValidation(r,c,items){
  var id=cellId(r,c);
  _dropdownValidations[id]=items;
  renderCellWithDropdown(r,c);
}

function renderCellWithDropdown(r,c){
  var id=cellId(r,c);
  var items=_dropdownValidations[id];
  if(!items||!items.length)return;
  var tdEl=document.getElementById('c-'+r+'-'+c);
  if(!tdEl)return;
  // Remove any existing dropdown arrow
  var existing=tdEl.querySelector('.dv-arrow');
  if(existing)existing.remove();
  // Add dropdown arrow button
  var arrow=document.createElement('div');
  arrow.className='dv-arrow';
  arrow.innerHTML='&#9660;';
  arrow.style.cssText='position:absolute;right:1px;top:0;bottom:0;width:16px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:8px;color:#555;background:rgba(255,255,255,0.85);border-left:1px solid #ccc;z-index:5;user-select:none;';
  arrow.addEventListener('mousedown',function(e){
    e.preventDefault();e.stopPropagation();
    var existing=document.getElementById('dv-list');
    if(existing){existing.remove();return;}
    showDropdownList(r,c,items,tdEl);
  });
  tdEl.appendChild(arrow);
}

function showDropdownList(r,c,items,tdEl){
  // Close any open dropdown list
  var existing=document.getElementById('dv-list');
  if(existing)existing.remove();
  var list=document.createElement('div');
  list.id='dv-list';
  var rect=tdEl.getBoundingClientRect();
  list.style.cssText='position:fixed;background:#fff;border:1px solid #1e6e3a;border-radius:3px;box-shadow:0 3px 10px rgba(0,0,0,0.18);z-index:99999;min-width:'+(rect.width)+'px;max-height:200px;overflow-y:auto;';
  list.style.left=rect.left+'px';
  list.style.top=rect.bottom+'px';
  items.forEach(function(item){
    var opt=document.createElement('div');
    opt.style.cssText='padding:4px 10px;font-size:11px;cursor:pointer;border-bottom:1px solid #f0f0f0;white-space:nowrap;';
    opt.textContent=item;
    opt.addEventListener('mouseenter',function(){opt.style.background='#e8f5e9';});
    opt.addEventListener('mouseleave',function(){opt.style.background='';});
    opt.addEventListener('mousedown',function(e){
      e.preventDefault();
      setRaw(r,c,item);
      selectCell(r,c);
      list.remove();
    });
    list.appendChild(opt);
  });
  document.body.appendChild(list);
  // Close on outside click
  setTimeout(function(){
    document.addEventListener('mousedown',function closeDvList(e){
      if(!list.contains(e.target)){list.remove();}
      document.removeEventListener('mousedown',closeDvList);
    });
  },0);
}

// Re-render dropdown arrows after sheet switch (called from switchSheet)
function reapplyDropdownValidations(){
  Object.keys(_dropdownValidations).forEach(function(id){
    var p=parseRef(id);
    if(p)renderCellWithDropdown(p.r,p.c);
  });
}

// ── Format Painter & Clear Format ─────────────────────────────────────────────
var _fmtPainterActive=false,_fmtPainterStyle=null,_fmtPainterFmt=null;
function formatPainter(){
  var id=cellId(selR,selC);
  _fmtPainterStyle=Object.assign({},cellStyle[id]||{});
  _fmtPainterFmt=cellFmt[id]||'';
  _fmtPainterActive=true;
  document.getElementById('btn-fmt-painter').classList.add('active');
  document.getElementById('sb-mode').textContent='Format Painter — click a cell to apply format';
}
function clearFormat(){
  var r1=rangeStart?Math.min(rangeStart.r,rangeEnd.r):selR;
  var r2=rangeStart?Math.max(rangeStart.r,rangeEnd.r):selR;
  var c1=rangeStart?Math.min(rangeStart.c,rangeEnd.c):selC;
  var c2=rangeStart?Math.max(rangeStart.c,rangeEnd.c):selC;
  for(var r=r1;r<=r2;r++)for(var c=c1;c<=c2;c++){
    var id=cellId(r,c);delete cellStyle[id];delete cellFmt[id];renderCell(r,c);
  }
  markUnsaved();document.getElementById('sb-mode').textContent='Format cleared';
}
// Format painter applied via selectCell override
var _origSelectCell=selectCell;
selectCell=function(r,c){
  _origSelectCell(r,c);
  if(_fmtPainterActive){
    var id=cellId(r,c);
    cellStyle[id]=Object.assign({},_fmtPainterStyle);
    if(_fmtPainterFmt)cellFmt[id]=_fmtPainterFmt;
    renderCell(r,c);
    _fmtPainterActive=false;
    document.getElementById('btn-fmt-painter').classList.remove('active');
    document.getElementById('sb-mode').textContent='Format applied';
    markUnsaved();
  }
};

// ── Border Picker ─────────────────────────────────────────────────────────────
var _borderLineColor = '#000000';
var _borderLineStyle = 'solid';
var _borderLineWidth = '1px';

function openBorderPicker(anchorEl){
  var existing=document.getElementById('border-picker-popup');
  if(existing){existing.remove();return;}

  var picker=document.createElement('div');
  picker.id='border-picker-popup';
  picker.style.cssText=[
    'position:fixed','background:#fff','border:1px solid #d0d0d0',
    'border-radius:6px','box-shadow:0 4px 20px rgba(0,0,0,0.18)',
    'z-index:99999','padding:10px 0','width:210px','font-family:Arial,sans-serif'
  ].join(';');

  // Helper: section header
  function addSectionHeader(txt){
    var h=document.createElement('div');
    h.style.cssText='font-size:11px;font-weight:700;color:#333;padding:8px 14px 4px;letter-spacing:0.02em;';
    h.textContent=txt;picker.appendChild(h);
  }

  // Helper: clickable border row
  function addBorderRow(iconSvg, label, action){
    var row=document.createElement('div');
    row.style.cssText='display:flex;align-items:center;padding:5px 14px;cursor:pointer;gap:10px;font-size:12px;color:#222;';
    row.innerHTML='<span style="flex-shrink:0;width:18px;height:18px;display:flex;align-items:center;justify-content:center;">'+iconSvg+'</span><span>'+label+'</span>';
    row.addEventListener('mouseenter',function(){row.style.background='#f0f7ff';});
    row.addEventListener('mouseleave',function(){row.style.background='';});
    row.addEventListener('mousedown',function(e){
      e.preventDefault();
      action();
      picker.remove();
    });
    picker.appendChild(row);
    return row;
  }

  // Helper: submenu row (has arrow)
  function addSubRow(iconSvg, label, buildSubFn){
    var row=document.createElement('div');
    row.style.cssText='display:flex;align-items:center;padding:5px 14px;cursor:pointer;gap:10px;font-size:12px;color:#222;position:relative;';
    row.innerHTML='<span style="flex-shrink:0;width:18px;height:18px;display:flex;align-items:center;justify-content:center;">'+iconSvg+'</span><span style="flex:1">'+label+'</span><span style="color:#888;font-size:10px;">▶</span>';
    var subMenu=null;
    row.addEventListener('mouseenter',function(){
      row.style.background='#f0f7ff';
      if(subMenu)return;
      subMenu=buildSubFn();
      var rr=row.getBoundingClientRect();
      subMenu.style.left=(rr.right+2)+'px';
      subMenu.style.top =rr.top+'px';
      document.body.appendChild(subMenu);
    });
    row.addEventListener('mouseleave',function(e){
      row.style.background='';
      // Only remove if not hovering the submenu
      if(subMenu&&!subMenu.contains(e.relatedTarget)){subMenu.remove();subMenu=null;}
    });
    picker.appendChild(row);
  }

  // Helper: divider
  function addDivider(){
    var d=document.createElement('div');
    d.style.cssText='height:1px;background:#e8e8e8;margin:4px 0;';
    picker.appendChild(d);
  }

  // Apply borders helper
  function applyBorderAction(sides, clear, thick){
    var r1=rangeStart?Math.min(rangeStart.r,rangeEnd.r):selR;
    var r2=rangeStart?Math.max(rangeStart.r,rangeEnd.r):selR;
    var c1=rangeStart?Math.min(rangeStart.c,rangeEnd.c):selC;
    var c2=rangeStart?Math.max(rangeStart.c,rangeEnd.c):selC;
    var bv=thick?('2px '+_borderLineStyle+' '+_borderLineColor):(_borderLineWidth+' '+_borderLineStyle+' '+_borderLineColor);
    for(var r=r1;r<=r2;r++)for(var c=c1;c<=c2;c++){
      var id=cellId(r,c);if(!cellStyle[id])cellStyle[id]={};
      if(clear){['bt','bb','bl','br'].forEach(function(s){delete cellStyle[id][s];});}
      else{
        // Outside border = only outer edges of the selection
        if(sides==='outside'){
          if(r===r1)cellStyle[id].bt=bv;
          if(r===r2)cellStyle[id].bb=bv;
          if(c===c1)cellStyle[id].bl=bv;
          if(c===c2)cellStyle[id].br=bv;
        } else {
          sides.forEach(function(s){cellStyle[id][s]=bv;});
        }
      }
      renderCell(r,c);
    }
    markUnsaved();
  }

  // SVG icons (simple line art matching WPS style)
  var I={
    none:'<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" fill="none" stroke="#ccc" stroke-width="1" stroke-dasharray="2"/></svg>',
    all:'<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" fill="none" stroke="#333" stroke-width="1.2"/><line x1="1" y1="7" x2="13" y2="7" stroke="#333" stroke-width="1"/><line x1="7" y1="1" x2="7" y2="13" stroke="#333" stroke-width="1"/></svg>',
    outside:'<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" fill="none" stroke="#333" stroke-width="1.5"/></svg>',
    thick:'<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" fill="none" stroke="#333" stroke-width="3"/></svg>',
    bottom:'<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" fill="none" stroke="#ccc" stroke-width="0.5"/><line x1="1" y1="13" x2="13" y2="13" stroke="#333" stroke-width="1.5"/></svg>',
    top:'<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" fill="none" stroke="#ccc" stroke-width="0.5"/><line x1="1" y1="1" x2="13" y2="1" stroke="#333" stroke-width="1.5"/></svg>',
    left:'<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" fill="none" stroke="#ccc" stroke-width="0.5"/><line x1="1" y1="1" x2="1" y2="13" stroke="#333" stroke-width="1.5"/></svg>',
    right:'<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" fill="none" stroke="#ccc" stroke-width="0.5"/><line x1="13" y1="1" x2="13" y2="13" stroke="#333" stroke-width="1.5"/></svg>',
    more:'<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" fill="none" stroke="#333" stroke-width="1"/><line x1="1" y1="5" x2="13" y2="5" stroke="#333" stroke-width="0.8"/><line x1="1" y1="9" x2="13" y2="9" stroke="#333" stroke-width="0.8"/></svg>',
    enhance:'<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" fill="none" stroke="#1e6e3a" stroke-width="1.5"/><line x1="1" y1="7" x2="13" y2="7" stroke="#1e6e3a" stroke-width="0.8"/><line x1="7" y1="1" x2="7" y2="13" stroke="#1e6e3a" stroke-width="0.8"/></svg>',
    draw:'<svg width="14" height="14" viewBox="0 0 14 14"><line x1="2" y1="12" x2="12" y2="2" stroke="#e55" stroke-width="1.5"/><rect x="1" y="1" width="12" height="12" fill="none" stroke="#ccc" stroke-width="0.5"/></svg>',
    drawgrid:'<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" fill="none" stroke="#e55" stroke-width="1"/><line x1="1" y1="7" x2="13" y2="7" stroke="#e55" stroke-width="0.8"/><line x1="7" y1="1" x2="7" y2="13" stroke="#e55" stroke-width="0.8"/></svg>',
    erase:'<svg width="14" height="14" viewBox="0 0 14 14"><line x1="2" y1="12" x2="12" y2="2" stroke="#e55" stroke-width="1.5" stroke-dasharray="3"/><rect x="1" y="1" width="12" height="12" fill="none" stroke="#ccc" stroke-width="0.5"/></svg>',
    color:'<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="8" fill="none" stroke="#333" stroke-width="0.8"/><rect x="1" y="10" width="12" height="3" fill="#e55"/></svg>',
    style:'<svg width="14" height="14" viewBox="0 0 14 14"><line x1="1" y1="4" x2="13" y2="4" stroke="#333" stroke-width="2"/><line x1="1" y1="8" x2="13" y2="8" stroke="#333" stroke-width="1" stroke-dasharray="2"/><line x1="1" y1="11" x2="13" y2="11" stroke="#333" stroke-width="0.5" stroke-dasharray="4"/></svg>'
  };

  // ── Section: Borders ──────────────────────────────────────────────────────
  addSectionHeader('Borders');
  addBorderRow(I.none,   'No Border',           function(){applyBorderAction(null,true,false);});
  addBorderRow(I.all,    'All Borders',          function(){applyBorderAction(['bt','bb','bl','br'],false,false);});
  addBorderRow(I.outside,'Outside Borders',      function(){applyBorderAction('outside',false,false);});
  addBorderRow(I.thick,  'Thick Outside Borders',function(){applyBorderAction('outside',false,true);});
  addBorderRow(I.bottom, 'Bottom Border',        function(){applyBorderAction(['bb'],false,false);});
  addBorderRow(I.top,    'Top Border',           function(){applyBorderAction(['bt'],false,false);});
  addBorderRow(I.left,   'Left Border',          function(){applyBorderAction(['bl'],false,false);});
  addBorderRow(I.right,  'Right Border',         function(){applyBorderAction(['br'],false,false);});

  // More Borders opens the border modal
  addBorderRow(I.more,'More Borders...', function(){openModal('modal-border');});

  // Enhance Table (all borders in green)
  addBorderRow(I.enhance,'Enhance Table', function(){
    _borderLineColor='#1e6e3a';
    applyBorderAction(['bt','bb','bl','br'],false,false);
    _borderLineColor='#000000';
  });

  addDivider();

  // ── Section: Draw Borders ─────────────────────────────────────────────────
  addSectionHeader('Draw Borders');
  addBorderRow(I.draw,    'Draw Border',     function(){alert('Draw Border: click and drag across cells to apply outside border.');});
  addBorderRow(I.drawgrid,'Draw Border Grid',function(){alert('Draw Border Grid: click and drag to apply all-borders style.');});
  addBorderRow(I.erase,   'Erase Border',    function(){applyBorderAction(null,true,false);});

  addDivider();

  // ── Line Color submenu ────────────────────────────────────────────────────
  addSubRow(I.color,'Line Color',function(){
    var sub=document.createElement('div');
    sub.style.cssText='position:fixed;background:#fff;border:1px solid #d0d0d0;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.18);z-index:100000;padding:8px;width:180px;';
    var colors=['#000000','#333333','#666666','#999999','#cccccc','#ffffff',
                '#c0392b','#e74c3c','#e67e22','#f39c12','#1e6e3a','#27ae60',
                '#1565c0','#2980b9','#5dade2','#6c3483','#8e44ad','#e91e63'];
    var grid=document.createElement('div');
    grid.style.cssText='display:grid;grid-template-columns:repeat(6,24px);gap:3px;';
    colors.forEach(function(col){
      var sw=document.createElement('div');
      sw.style.cssText='width:22px;height:22px;border-radius:3px;cursor:pointer;background:'+col+';border:1px solid #ccc;';
      sw.title=col;
      sw.addEventListener('mousedown',function(e){e.preventDefault();_borderLineColor=col;sub.remove();});
      sw.addEventListener('mouseenter',function(){sw.style.transform='scale(1.2)';});
      sw.addEventListener('mouseleave',function(){sw.style.transform='';});
      grid.appendChild(sw);
    });
    var lbl=document.createElement('div');lbl.style.cssText='font-size:10px;color:#666;margin-bottom:6px;font-weight:600;';lbl.textContent='Line Color';
    sub.appendChild(lbl);sub.appendChild(grid);
    // Custom color row
    var customRow=document.createElement('div');customRow.style.cssText='display:flex;align-items:center;gap:6px;margin-top:8px;';
    var cinput=document.createElement('input');cinput.type='color';cinput.value=_borderLineColor;cinput.style.cssText='width:28px;height:24px;border:none;cursor:pointer;padding:0;';
    var clbl=document.createElement('span');clbl.style.cssText='font-size:11px;color:#444;';clbl.textContent='Custom...';
    cinput.addEventListener('change',function(){_borderLineColor=cinput.value;sub.remove();});
    customRow.appendChild(cinput);customRow.appendChild(clbl);
    sub.appendChild(customRow);
    return sub;
  });

  // ── Line Style submenu ────────────────────────────────────────────────────
  addSubRow(I.style,'Line Style',function(){
    var sub=document.createElement('div');
    sub.style.cssText='position:fixed;background:#fff;border:1px solid #d0d0d0;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.18);z-index:100000;padding:8px 0;width:160px;';
    var styles=[
      {label:'Thin (1px)',    w:'1px', s:'solid'},
      {label:'Medium (2px)',  w:'2px', s:'solid'},
      {label:'Thick (3px)',   w:'3px', s:'solid'},
      {label:'Dashed',        w:'1px', s:'dashed'},
      {label:'Dotted',        w:'1px', s:'dotted'},
      {label:'Double',        w:'1px', s:'double'}
    ];
    styles.forEach(function(st){
      var row=document.createElement('div');
      row.style.cssText='display:flex;align-items:center;padding:5px 14px;cursor:pointer;gap:10px;';
      var preview=document.createElement('div');
      preview.style.cssText='width:60px;height:0;border-top:'+st.w+' '+st.s+' #333;';
      var lbl=document.createElement('span');lbl.style.cssText='font-size:11px;color:#333;';lbl.textContent=st.label;
      row.appendChild(preview);row.appendChild(lbl);
      row.addEventListener('mouseenter',function(){row.style.background='#f0f7ff';});
      row.addEventListener('mouseleave',function(){row.style.background='';});
      row.addEventListener('mousedown',function(e){e.preventDefault();_borderLineWidth=st.w;_borderLineStyle=st.s;sub.remove();});
      sub.appendChild(row);
    });
    return sub;
  });

  document.body.appendChild(picker);

  // Position below anchor button
  var rect=anchorEl?anchorEl.getBoundingClientRect():{left:200,bottom:80};
  var left=rect.left, top=rect.bottom+4;
  if(left+215>window.innerWidth)left=window.innerWidth-218;
  if(top+420>window.innerHeight)top=rect.top-424;
  picker.style.left=left+'px';
  picker.style.top =top+'px';

  // Close on outside click
  setTimeout(function(){
    document.addEventListener('mousedown',function closePicker(e){
      if(!picker.contains(e.target)){picker.remove();}
      document.removeEventListener('mousedown',closePicker,true);
    },true);
  },0);
}

// ── Find & Replace ────────────────────────────────────────────────────────────
function doFind(){openModal('modal-find');setTimeout(function(){document.getElementById('find-txt').focus();},100);}
function doReplace(){openModal('modal-find');setTimeout(function(){document.getElementById('find-txt').focus();},100);}
function findNext(){
  var q=document.getElementById('find-txt').value;if(!q)return;
  var matchCase=document.getElementById('find-case').checked;
  var wholeCell=document.getElementById('find-whole').checked;
  findResults=[];
  for(var r=0;r<ROWS;r++)for(var c=0;c<COLS;c++){
    var v=getRaw(r,c);
    var a=matchCase?v:v.toLowerCase(),b=matchCase?q:q.toLowerCase();
    if(wholeCell?a===b:a.includes(b))findResults.push({r,c});
  }
  if(!findResults.length){document.getElementById('find-result').textContent='Not found';return;}
  findIdx=(findIdx+1)%findResults.length;
  var f=findResults[findIdx];
  selectCell(f.r,f.c);
  document.getElementById('find-result').textContent='Match '+(findIdx+1)+' of '+findResults.length;
  document.getElementById('c-'+f.r+'-'+f.c).scrollIntoView({block:'center'});
}
function replaceAll(){
  var q=document.getElementById('find-txt').value,rep=document.getElementById('replace-txt').value;
  if(!q)return;var count=0;
  for(var r=0;r<ROWS;r++)for(var c=0;c<COLS;c++){var v=getRaw(r,c);if(v.includes(q)){setRaw(r,c,v.split(q).join(rep));count++;}}
  document.getElementById('find-result').textContent='Replaced '+count+' occurrence(s)';
}

// ── Comments ──────────────────────────────────────────────────────────────────
function insertComment(){
  document.getElementById('comment-cell-ref').textContent=cellId(selR,selC);
  document.getElementById('comment-text').value=cellComments[cellId(selR,selC)]||'';
  openModal('modal-comment');
}
function saveComment(){
  var txt=document.getElementById('comment-text').value.trim();
  if(txt)cellComments[cellId(selR,selC)]=txt;else delete cellComments[cellId(selR,selC)];
  renderCell(selR,selC);closeModal('modal-comment');markUnsaved();
}
function deleteComment(){delete cellComments[cellId(selR,selC)];renderCell(selR,selC);markUnsaved();}
function toggleComments(){
  var tips=document.querySelectorAll('.cell-comment');
  var vis=tips[0]&&tips[0].style.display!=='none';
  tips.forEach(function(t){t.style.display=vis?'none':'block';});
}
function showCommentTip(r,c){
  var txt=cellComments[cellId(r,c)];if(!txt)return;
  var tip=document.getElementById('comment-tip');
  var cell=document.getElementById('c-'+r+'-'+c);var rect=cell.getBoundingClientRect();
  tip.textContent=txt;tip.style.display='block';
  tip.style.left=rect.right+'px';tip.style.top=rect.top+'px';
}
function hideCommentTip(){document.getElementById('comment-tip').style.display='none';}

// ── Protect ───────────────────────────────────────────────────────────────────
function lockCell(){
  var id=cellId(selR,selC);
  if(lockedCells.has(id)){lockedCells.delete(id);document.getElementById('c-'+selR+'-'+selC).classList.remove('locked');}
  else{lockedCells.add(id);document.getElementById('c-'+selR+'-'+selC).classList.add('locked');}
  document.getElementById('btn-lock').classList.toggle('active',lockedCells.has(id));
}
function applyProtect(){
  sheetProtected=true;closeModal('modal-protect');
  document.getElementById('sb-mode').textContent='Sheet Protected';
}
function shareWorkbook(){alert('Share: Save your file and share it via email or cloud storage. JainSheet files use .json format.');}

// ── Page Layout ───────────────────────────────────────────────────────────────
function setOrientation(o){
  pageOrientation=o;
  document.getElementById('btn-portrait').classList.toggle('active',o==='portrait');
  document.getElementById('btn-landscape').classList.toggle('active',o==='landscape');
  document.getElementById('sb-page').textContent='Page: '+document.getElementById('page-size').value+' '+o.charAt(0).toUpperCase()+o.slice(1);
}
function setPageSize(s){pageSize=s;document.getElementById('sb-page').textContent='Page: '+s+' '+pageOrientation.charAt(0).toUpperCase()+pageOrientation.slice(1);}
function insertPageBreak(){alert('Page break inserted before row '+(selR+1));}
function removePageBreak(){alert('Page break removed.');}
function setMargins(){var m=prompt('Set margins (cm) — Top,Right,Bottom,Left:','2,2,2,2');if(m)alert('Margins set to: '+m+' cm');}
function setScale(v){setZoom(parseInt(v));}

// ── View ──────────────────────────────────────────────────────────────────────
function toggleGridlines(){
  gridlines=!gridlines;
  document.querySelectorAll('.dc').forEach(function(el){el.style.borderColor=gridlines?'#d0d0d0':'transparent';});
  document.getElementById('btn-grid').classList.toggle('active',!gridlines);
}
function toggleFreeze(){
  if(frozenRows===0&&frozenCols===0){
    // Freeze at current cell — rows 0..selR-1 and cols 0..selC-1 become sticky
    frozenRows=selR;frozenCols=selC;
    document.getElementById('btn-freeze').classList.add('active');
    document.getElementById('sb-mode').textContent='Frozen at row '+(selR+1)+', col '+colName(selC);
  }else{
    frozenRows=0;frozenCols=0;
    document.getElementById('btn-freeze').classList.remove('active');
    document.getElementById('sb-mode').textContent='Panes unfrozen';
  }
  applyFreeze();
}

function applyFreeze(){
  // ── Column headers (thead th): always sticky top:0 ──────────────────────────
  // (thead th already has top:0 sticky via CSS — nothing extra needed there)

  // ── Row headers (tbody th.rh): always sticky left:0 ─────────────────────────
  // (already set in CSS — nothing extra needed)

  // ── Frozen rows: make the first frozenRows tbody rows sticky ─────────────────
  // We give each frozen data row a sticky top offset stacked below the thead.
  var theadHeight=24; // matches CSS height:24px on thead tr th
  for(var r=0;r<ROWS;r++){
    var tr=document.getElementById('tr-'+r);
    if(!tr)continue;
    if(frozenRows>0&&r<frozenRows){
      // Calculate cumulative top offset for this frozen row
      var topOff=theadHeight;
      for(var pr=0;pr<r;pr++){
        var prevTr=document.getElementById('tr-'+pr);
        topOff+=prevTr?(prevTr.offsetHeight||22):22;
      }
      tr.style.position='sticky';
      tr.style.top=topOff+'px';
      tr.style.zIndex='2';
      tr.style.background=darkMode?'#252526':'#fff';
    }else{
      tr.style.position='';
      tr.style.top='';
      tr.style.zIndex='';
      tr.style.background='';
    }
  }

  // ── Frozen cols: make the first frozenCols data cells in every row sticky ────
  // Each frozen cell gets left = rowHeaderWidth + sum-of-widths-of-prior-frozen-cols
  var rhWidth=52; // matches .rh width:52px
  for(var r=0;r<ROWS;r++){
    for(var c=0;c<COLS;c++){
      var td=document.getElementById('c-'+r+'-'+c);
      if(!td)continue;
      if(frozenCols>0&&c<frozenCols){
        var leftOff=rhWidth;
        for(var pc=0;pc<c;pc++){
          leftOff+=colWidths[pc]||82;
        }
        td.style.position='sticky';
        td.style.left=leftOff+'px';
        td.style.zIndex=(frozenRows>0&&r<frozenRows)?'3':'1';
        td.style.background=darkMode?'#252526':'#fff';
        // Subtle right border to mark freeze line
        if(c===frozenCols-1){td.style.borderRight='2px solid #1e6e3a';}
        else{td.style.borderRight='';}
      }else{
        td.style.position='';
        td.style.left='';
        td.style.zIndex='';
        td.style.background='';
        td.style.borderRight='';
      }
    }
  }
  // Frozen column headers
  for(var c=0;c<COLS;c++){
    var th=document.getElementById('ch-'+c);
    if(!th)continue;
    if(frozenCols>0&&c<frozenCols){
      var leftOff=rhWidth;
      for(var pc=0;pc<c;pc++) leftOff+=colWidths[pc]||82;
      th.style.left=leftOff+'px';
      th.style.zIndex='4';
      if(c===frozenCols-1) th.style.borderRight='2px solid #1e6e3a';
      else th.style.borderRight='';
    }else{
      th.style.left='';
      th.style.zIndex='';
      th.style.borderRight='';
    }
  }
}
function toggleRuler(){showRuler=!showRuler;document.getElementById('ruler').style.display=showRuler?'block':'none';document.getElementById('btn-ruler').classList.toggle('active',showRuler);}
function toggleHeaders(){
  showHeaders=!showHeaders;
  document.querySelectorAll('.ch,.rh').forEach(function(el){el.style.visibility=showHeaders?'':'hidden';});
  document.getElementById('btn-headers').classList.toggle('active',!showHeaders);
}
function setView(v){
  document.getElementById('btn-viewnormal').classList.toggle('active',v==='normal');
  document.getElementById('btn-viewpb').classList.toggle('active',v==='pagebreak');
  document.getElementById('sb-mode').textContent=v==='pagebreak'?'Page Break Preview':'Normal View';
}
function zoomChange(delta){setZoom(Math.max(50,Math.min(200,zoom+delta)));}
function zoomReset(){setZoom(100);}
function setZoom(v){
  zoom=v;
  document.getElementById('zoom-val').textContent=v+'%';
  document.getElementById('sb-zoom-display').textContent=v+'%';
  // Use CSS zoom (Chromium/Electron native) — unlike transform:scale it does NOT
  // break position:sticky on column/row headers.
  var gw=document.getElementById('grid-wrap');
  gw.style.transform='';
  gw.style.zoom=v+'%';
}

// ── Tools ─────────────────────────────────────────────────────────────────────
function runMacro(){
  var code=document.getElementById('macro-script').value;
  try{eval(code);renderAll();document.getElementById('macro-result').textContent='✓ Macro ran successfully';}
  catch(e){document.getElementById('macro-result').textContent='Error: '+e.message;}
}
function saveMacro(){
  var name=document.getElementById('macro-name').value.trim()||'Macro1';
  macros[name]=document.getElementById('macro-script').value;
  document.getElementById('macro-result').textContent='Saved as "'+name+'"';
}
function runScript(){
  var code=document.getElementById('script-code').value;
  try{eval(code);renderAll();document.getElementById('script-result').style.color='#1e6e3a';document.getElementById('script-result').textContent='✓ Script completed';}
  catch(e){document.getElementById('script-result').style.color='#c0392b';document.getElementById('script-result').textContent='Error: '+e.message;}
}
function applyOptions(){
  var font=document.getElementById('opt-font').value;
  var size=document.getElementById('opt-size').value;
  autoCalc=document.getElementById('opt-autocalc').checked;
  if(!document.getElementById('opt-gridlines').checked&&gridlines)toggleGridlines();
  document.getElementById('font-family').value=font;
  document.getElementById('font-size').value=size;
  closeModal('modal-options');
}
function calcNow(){renderAll();document.getElementById('sb-mode').textContent='Calculated';}
function toggleAutoCalc(){autoCalc=!autoCalc;document.getElementById('btn-autocalc').classList.toggle('active',autoCalc);document.getElementById('sb-mode').textContent='Auto Calc: '+(autoCalc?'ON':'OFF');}
function spellCheck(){
  var common=['the','is','and','are','for','not','you','this','but','his','her','they','we'];
  var suspect=[];
  for(var r=0;r<ROWS;r++)for(var c=0;c<COLS;c++){var v=getRaw(r,c);if(v&&isNaN(parseFloat(v))&&!v.startsWith('=')&&v.length>2&&v.split(' ').some(function(w){return w.length>2&&!common.includes(w.toLowerCase())&&w===w.toUpperCase();}))suspect.push(cellId(r,c)+': '+v);}
  alert(suspect.length?'Possible issues:\n'+suspect.slice(0,10).join('\n'):'No spelling issues found (basic check).');
}

// ── Insert Link & Symbol ──────────────────────────────────────────────────────
function applyLink(){
  var txt=document.getElementById('link-text').value||document.getElementById('link-url').value;
  var url=document.getElementById('link-url').value;
  setRaw(selR,selC,txt);
  var id=cellId(selR,selC);if(!cellStyle[id])cellStyle[id]={};
  cellStyle[id].color='#1565c0';cellStyle[id].underline=true;
  renderCell(selR,selC);closeModal('modal-link');
}
function insertSymbol(){
  var s=document.getElementById('symbol-selected').textContent;
  if(s){setRaw(selR,selC,getRaw(selR,selC)+s);}
  closeModal('modal-symbol');
}
function insertSparkline(){alert('Sparkline: Select a data range and a target cell, then use the Script Editor to create custom mini-charts.');}

// ── Formula modal ─────────────────────────────────────────────────────────────
function updateFnDesc(){
  var fn=document.getElementById('fn-select').value;
  var args=document.getElementById('fn-args').value||'...';
  document.getElementById('fn-preview').value='='+fn+'('+args+')';
}
function applyFnInsert(){
  var fn=document.getElementById('fn-select').value;
  var args=document.getElementById('fn-args').value||'';
  var formula='='+fn+'('+args+')';
  setRaw(selR,selC,formula);fi.value=formula;
  closeModal('modal-formula');
}

// ── Named Ranges ──────────────────────────────────────────────────────────────
function addNamedRange(){
  var name=document.getElementById('nm-name').value.trim();
  var ref=document.getElementById('nm-ref').value.trim();
  if(!name||!ref){alert('Enter both name and reference.');return;}
  namedRanges[name]=ref;
  refreshNameList();
  document.getElementById('sb-mode').textContent='Named range "'+name+'" added';
}
function refreshNameList(){
  var list=document.getElementById('nm-list');
  if(!list)return;
  var keys=Object.keys(namedRanges);
  list.innerHTML=keys.length?keys.map(function(k){return'<div style="padding:3px 0;border-bottom:1px solid #f0f0f0"><strong>'+k+'</strong> → '+namedRanges[k]+'</div>';}).join(''):'<em style="color:#aaa">No named ranges defined</em>';
}

// ── Data Analysis ─────────────────────────────────────────────────────────────
function openStatsModal(){
  var vals=[];
  for(var r=0;r<ROWS;r++)for(var c=0;c<COLS;c++){var raw=getRaw(r,c);var v=raw&&raw.startsWith('=')?evalFormula(raw):raw;var n=parseFloat(v);if(!isNaN(n))vals.push(n);}
  if(!vals.length){document.getElementById('stats-content').innerHTML='<em>No numeric data found</em>';return;}
  vals.sort(function(a,b){return a-b;});
  var sum=vals.reduce(function(a,b){return a+b;},0);
  var mean=sum/vals.length;
  var variance=vals.reduce(function(s,v){return s+Math.pow(v-mean,2);},0)/vals.length;
  var median=vals.length%2===0?(vals[vals.length/2-1]+vals[vals.length/2])/2:vals[Math.floor(vals.length/2)];
  document.getElementById('stats-content').innerHTML=
    '<table style="width:100%;border-collapse:collapse">'+
    '<tr><td style="padding:4px 8px;border-bottom:1px solid #eee"><b>Count</b></td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">'+vals.length+'</td></tr>'+
    '<tr><td style="padding:4px 8px;border-bottom:1px solid #eee"><b>Sum</b></td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">'+sum.toFixed(2)+'</td></tr>'+
    '<tr><td style="padding:4px 8px;border-bottom:1px solid #eee"><b>Mean</b></td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">'+mean.toFixed(4)+'</td></tr>'+
    '<tr><td style="padding:4px 8px;border-bottom:1px solid #eee"><b>Median</b></td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">'+median.toFixed(4)+'</td></tr>'+
    '<tr><td style="padding:4px 8px;border-bottom:1px solid #eee"><b>Std Dev</b></td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">'+Math.sqrt(variance).toFixed(4)+'</td></tr>'+
    '<tr><td style="padding:4px 8px;border-bottom:1px solid #eee"><b>Min</b></td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">'+vals[0]+'</td></tr>'+
    '<tr><td style="padding:4px 8px;"><b>Max</b></td><td style="padding:4px 8px;text-align:right">'+vals[vals.length-1]+'</td></tr>'+
    '</table>';
}

// ── Chart ─────────────────────────────────────────────────────────────────────
function previewChart(){
  var range=document.getElementById('chart-range').value;
  var canvas=document.getElementById('chart-canvas');
  if(!range||!canvas)return;
  var parsed=parseRangeStr(range);if(!parsed)return;
  var labels=[],values=[];
  for(var r=parsed.r1;r<=parsed.r2;r++){labels.push(cellId(r,parsed.c1));values.push(parseFloat(getRaw(r,parsed.c1))||0);}
  drawSimpleChart(canvas,document.getElementById('chart-type').value,labels,values);
}
function parseRangeStr(s){
  var m=s.match(/([A-Z]+\d+):([A-Z]+\d+)/);
  if(!m)return null;
  var a=parseRef(m[1]),b=parseRef(m[2]);
  if(!a||!b)return null;
  return{r1:a.r,c1:a.c,r2:b.r,c2:b.c};
}
function drawSimpleChart(canvas,type,labels,values){
  var ctx=canvas.getContext('2d');var w=canvas.parentElement.clientWidth||400,h=180;
  canvas.width=w;canvas.height=h;ctx.clearRect(0,0,w,h);
  var max=Math.max.apply(null,values)||1;
  var colors=['#1e6e3a','#2196f3','#ff9800','#e91e63','#9c27b0','#00bcd4'];
  if(type==='bar'||type==='area'){
    var bw=Math.floor((w-60)/(labels.length+1));
    labels.forEach(function(l,i){
      var bh=Math.floor((values[i]/max)*(h-40));
      var x=40+i*(bw+4),y=h-20-bh;
      ctx.fillStyle=colors[i%colors.length];
      if(type==='bar'){ctx.fillRect(x,y,bw,bh);}
      else{ctx.globalAlpha=0.5;ctx.fillRect(x,h-20,bw,-bh);ctx.globalAlpha=1;}
      ctx.fillStyle='#333';ctx.font='9px Arial';ctx.fillText(l,x,h-6);
    });
  }else if(type==='line'){
    ctx.beginPath();ctx.strokeStyle='#1e6e3a';ctx.lineWidth=2;
    labels.forEach(function(l,i){
      var x=40+i*((w-60)/(labels.length-1||1));
      var y=(h-20)-Math.floor((values[i]/max)*(h-40));
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
      ctx.fillStyle='#1e6e3a';ctx.fillRect(x-3,y-3,6,6);
    });
    ctx.stroke();
  }else if(type==='pie'){
    var total=values.reduce(function(a,b){return a+b;},0)||1;
    var angle=-Math.PI/2,cx=w/2,cy=h/2,rad=Math.min(cx,cy)-20;
    values.forEach(function(v,i){var slice=(v/total)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,rad,angle,angle+slice);ctx.fillStyle=colors[i%colors.length];ctx.fill();angle+=slice;});
  }
}
function insertChart(){
  var title=document.getElementById('chart-title').value||'Chart';
  document.getElementById('sb-mode').textContent='Chart "'+title+'" created (preview shown above)';
  closeModal('modal-chart');
}

// ── Undo/Redo ─────────────────────────────────────────────────────────────────
function doUndo(){if(!undoStack.length)return;var o=undoStack.pop(),p=parseRef(o.id);if(!p)return;redoStack.push({id:o.id,prev:getRaw(p.r,p.c)});if(o.prev==='')delete data[o.id];else data[o.id]=o.prev;renderCell(p.r,p.c);}
function doRedo(){if(!redoStack.length)return;var o=redoStack.pop(),p=parseRef(o.id);if(!p)return;undoStack.push({id:o.id,prev:getRaw(p.r,p.c)});if(o.prev==='')delete data[o.id];else data[o.id]=o.prev;renderCell(p.r,p.c);}

// ── Context Menu ──────────────────────────────────────────────────────────────
function showCtx(e,r,c){
  e.preventDefault();selectCell(r,c);
  var m=document.getElementById('ctx');
  m.style.display='block';
  m.style.left=Math.min(e.clientX,window.innerWidth-200)+'px';
  m.style.top=Math.min(e.clientY,window.innerHeight-200)+'px';
}
document.addEventListener('click',function(e){if(!e.target.closest('#ctx'))document.getElementById('ctx').style.display='none';});
function ctxAct(act){
  document.getElementById('ctx').style.display='none';
  if(act==='copy')clipCopy();
  if(act==='cut')clipCut();
  if(act==='paste')clipPaste();
  if(act==='insertRow')insertRowAbove();
  if(act==='deleteRow')deleteSelectedRow();
  if(act==='insertCol')insertColLeft();
  if(act==='deleteCol')deleteSelectedCol();
  if(act==='comment')insertComment();
  if(act==='clear')clearCells();
  if(act==='format')openModal('modal-formula');
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(id){
  document.querySelectorAll('.modal-bg').forEach(function(m){m.classList.remove('open');});
  var m=document.getElementById(id);if(!m)return;m.classList.add('open');
  if(id==='modal-symbol')buildSymbolGrid();
  if(id==='modal-stats')openStatsModal();
  if(id==='modal-namemanager')refreshNameList();
  if(id==='modal-chart')setTimeout(previewChart,100);
}
function closeModal(id){var m=document.getElementById(id);if(m)m.classList.remove('open');}
document.addEventListener('keydown',function(e){if(e.key==='Escape')document.querySelectorAll('.modal-bg.open').forEach(function(m){m.classList.remove('open');});});
function buildSymbolGrid(){
  var syms=['©','®','™','°','±','×','÷','√','∞','≠','≤','≥','½','¼','¾','α','β','γ','δ','π','Σ','Ω','µ','€','£','¥','¢','†','‡','•','…','′','″','←','→','↑','↓','↔','⇒','⇔','★','☆','♠','♣','♥','♦','☺','☻','✓','✗'];
  var grid=document.getElementById('symbol-grid');grid.innerHTML='';
  syms.forEach(function(s){var btn=document.createElement('button');btn.textContent=s;btn.style.cssText='padding:4px;font-size:14px;cursor:pointer;border:1px solid #ddd;border-radius:3px;background:#fff;';btn.onclick=function(){document.getElementById('symbol-selected').textContent=s;};grid.appendChild(btn);});
}

// ── Save/Load/Export ──────────────────────────────────────────────────────────
function markUnsaved(){unsaved=true;document.getElementById('save-status').textContent='● Unsaved';}
function markSaved(){unsaved=false;document.getElementById('save-status').textContent='✓ Saved';setTimeout(function(){if(!unsaved)document.getElementById('save-status').textContent='';},2000);}
function getState(){
  return JSON.stringify({
    version:2,
    activeSheet:activeSheet,
    sheets:sheets.map(function(sh){
      return {
        name:sh.name,
        data:sh.data,
        cellFmt:sh.cellFmt,
        cellStyle:sh.cellStyle,
        cellComments:sh.cellComments,
        namedRanges:sh.namedRanges,
        lockedCells:Array.from(sh.lockedCells),
        colWidths:sh.colWidths,
        rowHeights:sh.rowHeights
      };
    })
  });
}
function loadState(json){
  var s=JSON.parse(json);
  // v2 multi-sheet format
  if(s.version===2&&s.sheets){
    sheets=s.sheets.map(function(sh){
      return {
        name:sh.name||'Sheet1',
        data:sh.data||{},
        cellFmt:sh.cellFmt||{},
        cellStyle:sh.cellStyle||{},
        cellComments:sh.cellComments||{},
        namedRanges:sh.namedRanges||{},
        lockedCells:new Set(sh.lockedCells||[]),
        colWidths:sh.colWidths||{},
        rowHeights:sh.rowHeights||{}
      };
    });
    activeSheet=s.activeSheet||0;
    bindSheet();
    renderSheetTabs();
    renderAll();
  } else {
    // v1 backward compat — single sheet
    bindSheet();
    Object.assign(data,s.data||{});
    Object.assign(cellFmt,s.cellFmt||{});
    Object.assign(cellStyle,s.cellStyle||{});
    Object.assign(cellComments,s.cellComments||{});
    Object.assign(namedRanges,s.namedRanges||{});
    if(s.lockedCells)s.lockedCells.forEach(function(id){lockedCells.add(id);});
    renderAll();
  }
}
function exportCsv(){
  var csv='';
  for(var r=0;r<ROWS;r++){
    var row=[],hasData=false;
    for(var c=0;c<COLS;c++){var v=getRaw(r,c);if(v)hasData=true;row.push(v.indexOf(',')>=0?'"'+v+'"':v);}
    if(hasData)csv+=row.join(',')+'\n';
  }
  return csv;
}

// ── XLSX Export via SheetJS ───────────────────────────────────────────────────
function exportXlsx(filePath){
  try {
    var XLSX = require('xlsx');
    var wb = XLSX.utils.book_new();

    // Helper: parse CSS border string like "1px solid #ff0000"
    function parseBorderStr(cssStr){
      if(!cssStr) return null;
      var parts = cssStr.trim().split(/\s+/);
      var px = parseInt(parts[0]) || 1;
      var bStyle = px >= 2 ? 'medium' : 'thin';
      if(parts[1] === 'dashed') bStyle = 'dashed';
      if(parts[1] === 'dotted') bStyle = 'dotted';
      var col = (parts[2] || '#000000').replace('#','').padStart(6,'0');
      return { style: bStyle, color: { rgb: col.toUpperCase() } };
    }

    // Helper: rgb/hex color to ARGB string for SheetJS
    function toRgb(hex){
      if(!hex) return null;
      return hex.replace('#','').padStart(6,'0').toUpperCase();
    }

    sheets.forEach(function(sh){
      var maxR = 0, maxC = 0;
      Object.keys(sh.data).forEach(function(id){
        var p = parseRef(id);
        if(p){ maxR=Math.max(maxR,p.r); maxC=Math.max(maxC,p.c); }
      });
      if(maxR === 0 && maxC === 0 && !sh.data['A1']) {
        // Empty sheet — still append it
        var ws = {};
        ws['!ref'] = 'A1';
        XLSX.utils.book_append_sheet(wb, ws, sh.name);
        return;
      }

      var ws = {};
      for(var r=0; r<=maxR; r++){
        for(var c=0; c<=maxC; c++){
          var id = cellId(r,c);
          var raw = sh.data[id];
          var fmt = sh.cellFmt[id] || '';
          var st  = sh.cellStyle[id] || {};
          var addr = XLSX.utils.encode_cell({r:r, c:c});
          var cell = {};

          // ── Value / Formula ──────────────────────────────────────────────
          if(raw && raw.startsWith('=')){
            cell.f = raw.slice(1);          // formula (Excel re-evaluates)
            var ev = evalFormula(raw);
            var evN = parseFloat(ev);
            if(!isNaN(evN)){ cell.v = evN; cell.t = 'n'; }
            else { cell.v = String(ev); cell.t = 's'; }
          } else if(raw !== undefined && raw !== '') {
            var n = parseFloat(raw);
            if(!isNaN(n) && String(raw).trim() !== ''){
              cell.v = n; cell.t = 'n';
            } else {
              cell.v = raw; cell.t = 's';
            }
          } else {
            continue; // skip empty cells
          }

          // ── Style object ─────────────────────────────────────────────────
          var xf = {};

          // Font
          var font = {};
          if(st.bold)       font.bold      = true;
          if(st.italic)     font.italic    = true;
          if(st.underline)  font.underline = true;
          if(st.strike)     font.strike    = true;
          if(st.fontSize)   font.sz        = parseInt(st.fontSize);
          if(st.fontFamily) font.name      = st.fontFamily;
          if(st.color)      font.color     = { rgb: toRgb(st.color) };
          if(Object.keys(font).length) xf.font = font;

          // Fill
          if(st.bg){
            xf.fill = { patternType: 'solid', fgColor: { rgb: toRgb(st.bg) } };
          }

          // Alignment
          var align = {};
          if(st.align === 'left')   align.horizontal = 'left';
          if(st.align === 'center') align.horizontal = 'center';
          if(st.align === 'right')  align.horizontal = 'right';
          if(st.wrap)               align.wrapText   = true;
          if(Object.keys(align).length) xf.alignment = align;

          // Borders
          var border = {};
          var bTop = parseBorderStr(st.bt); if(bTop) border.top    = bTop;
          var bBot = parseBorderStr(st.bb); if(bBot) border.bottom = bBot;
          var bLft = parseBorderStr(st.bl); if(bLft) border.left   = bLft;
          var bRgt = parseBorderStr(st.br); if(bRgt) border.right  = bRgt;
          if(Object.keys(border).length) xf.border = border;

          // Number format
          var numFmt = '';
          if(fmt === 'currency') numFmt = '"₹"#,##0.00';
          if(fmt === 'usd')      numFmt = '"$"#,##0.00';
          if(fmt === 'percent')  numFmt = '0.00%';
          if(fmt === 'number')   numFmt = '0.00';
          if(fmt === 'integer')  numFmt = '0';
          if(fmt === 'sci')      numFmt = '0.00E+00';
          if(fmt === 'date')     numFmt = 'DD/MM/YYYY';
          if(fmt === 'time')     numFmt = 'HH:MM:SS';
          if(numFmt) xf.numFmt = numFmt;

          if(Object.keys(xf).length) cell.s = xf;

          ws[addr] = cell;
        }
      }

      ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0}, e:{r:maxR,c:maxC}});

      // Column widths (pixels → Excel character units: divide by ~7)
      var cols = [];
      for(var c=0; c<=maxC; c++){
        cols.push({ wch: Math.max(8, Math.round((sh.colWidths[c] || 82) / 7)) });
      }
      ws['!cols'] = cols;

      XLSX.utils.book_append_sheet(wb, ws, sh.name);
    });

    var ext = filePath.split('.').pop().toLowerCase();
    var bookType = ext === 'xls' ? 'biff8' : 'xlsx';
    var buf = XLSX.write(wb, { type:'base64', bookType: bookType, cellStyles: true });
    window.electronAPI.writeFile({filePath: filePath, content: buf, isBuffer: true});
  } catch(e) {
    alert('XLSX export failed: '+e.message);
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(function(t){
  t.addEventListener('click',function(){
    document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active');});
    document.querySelectorAll('.tab-content').forEach(function(x){x.classList.remove('active');});
    t.classList.add('active');document.getElementById('tab-'+t.dataset.tab).classList.add('active');
  });
});

// ── fn-select live preview ────────────────────────────────────────────────────
var fnSel=document.getElementById('fn-select');
var fnArgs=document.getElementById('fn-args');
if(fnSel)fnSel.addEventListener('change',updateFnDesc);
if(fnArgs)fnArgs.addEventListener('input',updateFnDesc);


// ── Fill Handle (+drag to fill) ───────────────────────────────────────────────
var fillDragging=false,fillStartR=-1,fillStartC=-1,fillEndR=-1,fillEndC=-1,fillDir=null;

function positionFillHandle(r,c){
  var cell=document.getElementById('c-'+r+'-'+c);
  var handle=document.getElementById('fill-handle');
  if(!cell||!handle)return;
  var raw=getRaw(r,c);
  var val=raw&&raw.startsWith('=')?evalFormula(raw):raw;
  var isNum=!isNaN(parseFloat(val))&&val!=='';
  if(!isNum){handle.style.display='none';return;}
  var cont=document.getElementById('grid-container');
  var cr=cont.getBoundingClientRect();
  var cellRect=cell.getBoundingClientRect();
  handle.style.display='block';
  handle.style.left=(cellRect.right-cr.left+cont.scrollLeft-5)+'px';
  handle.style.top=(cellRect.bottom-cr.top+cont.scrollTop-5)+'px';
}

function hideFillHandle(){
  var h=document.getElementById('fill-handle');
  if(h)h.style.display='none';
}

function clearFillPreview(){
  document.querySelectorAll('.fill-preview').forEach(function(el){el.classList.remove('fill-preview');});
}

function showFillPreview(startR,startC,endR,endC,dir){
  clearFillPreview();
  if(dir==='down'){
    for(var r=startR+1;r<=endR;r++){var el=document.getElementById('c-'+r+'-'+startC);if(el)el.classList.add('fill-preview');}
  }else if(dir==='right'){
    for(var c=startC+1;c<=endC;c++){var el=document.getElementById('c-'+startR+'-'+c);if(el)el.classList.add('fill-preview');}
  }
}

document.getElementById('fill-handle').addEventListener('mousedown',function(e){
  if(e.button!==0)return;
  e.preventDefault();e.stopPropagation();
  var raw=getRaw(selR,selC);
  var val=raw&&raw.startsWith('=')?evalFormula(raw):raw;
  if(isNaN(parseFloat(val)))return;
  fillDragging=true;fillStartR=selR;fillStartC=selC;fillEndR=selR;fillEndC=selC;fillDir=null;
  document.body.style.cursor='crosshair';
  document.body.style.userSelect='none';
});

document.addEventListener('mousemove',function(e){
  if(!fillDragging)return;
  // Find which cell the mouse is over
  var els=document.elementsFromPoint(e.clientX,e.clientY);
  var td=null;
  for(var i=0;i<els.length;i++){if(els[i].classList&&els[i].classList.contains('dc')){td=els[i];break;}}
  if(!td)return;
  var parts=td.id.split('-');
  if(parts.length<3)return;
  var hoverR=parseInt(parts[1]),hoverC=parseInt(parts[2]);

  // Determine direction — only down or right, not up or left
  var dr=hoverR-fillStartR,dc=hoverC-fillStartC;
  if(dr<=0&&dc<=0){clearFillPreview();fillDir=null;fillEndR=fillStartR;fillEndC=fillStartC;return;}

  // Primary direction is whichever delta is larger
  if(dr>=dc){
    // Dragging DOWN
    if(hoverR>fillStartR){
      fillDir='down';fillEndR=hoverR;fillEndC=fillStartC;
      showFillPreview(fillStartR,fillStartC,fillEndR,fillEndC,'down');
      // Show increment previews in cells
      var baseVal=parseFloat(getRaw(fillStartR,fillStartC));
      for(var r=fillStartR+1;r<=fillEndR;r++){
        var dv=document.getElementById('d-'+r+'-'+fillStartC);
        if(dv&&!dv.querySelector('input'))dv.textContent=(baseVal+(r-fillStartR));
      }
    }
  }else{
    // Dragging RIGHT
    if(hoverC>fillStartC){
      fillDir='right';fillEndR=fillStartR;fillEndC=hoverC;
      showFillPreview(fillStartR,fillStartC,fillEndR,fillEndC,'right');
      var baseVal=parseFloat(getRaw(fillStartR,fillStartC));
      for(var c=fillStartC+1;c<=fillEndC;c++){
        var dv=document.getElementById('d-'+fillStartR+'-'+c);
        if(dv&&!dv.querySelector('input'))dv.textContent=(baseVal+(c-fillStartC));
      }
    }
  }
});

document.addEventListener('mouseup',function(e){
  if(!fillDragging)return;
  fillDragging=false;
  document.body.style.cursor='';
  document.body.style.userSelect='';
  clearFillPreview();

  if(!fillDir||fillEndR===fillStartR&&fillEndC===fillStartC){
    // Restore cells that had preview text
    renderAll();
    return;
  }

  var baseVal=parseFloat(getRaw(fillStartR,fillStartC));
  if(isNaN(baseVal)){renderAll();return;}

  if(fillDir==='down'){
    for(var r=fillStartR+1;r<=fillEndR;r++){
      var val=String(baseVal+(r-fillStartR));
      var srcId=cellId(fillStartR,fillStartC);
      var dstId=cellId(r,fillStartC);
      // Copy style and format BEFORE setting value
      var srcStyle=cellStyle[srcId]||{};
      if(Object.keys(srcStyle).length>0){
        cellStyle[dstId]=JSON.parse(JSON.stringify(srcStyle));
      }
      if(cellFmt[srcId]) cellFmt[dstId]=cellFmt[srcId];
      // Set value without undo
      if(val==='') delete data[dstId]; else data[dstId]=val;
      // Apply directly to DOM — bypass setRaw to avoid recalc loop
      var dv=document.getElementById('d-'+r+'-'+fillStartC);
      if(dv){
        dv.textContent=val;
        // Apply alignment directly
        var align=srcStyle.align||'right';
        dv.style.textAlign=align;
        var td=document.getElementById('c-'+r+'-'+fillStartC);
        if(td) td.style.textAlign=align;
      }
    }
    recalcDependents();
    markUnsaved();
    // Restore any cells below fillEndR that had preview text from earlier hover
    for(var r=fillEndR+1;r<ROWS;r++) renderCell(r,fillStartC);
  }else if(fillDir==='right'){
    for(var c=fillStartC+1;c<=fillEndC;c++){
      setRaw(fillStartR,c,String(baseVal+(c-fillStartC)));
    }
    for(var c=fillEndC+1;c<COLS;c++) renderCell(fillStartR,c);
  }

  fillDir=null;fillEndR=fillStartR;fillEndC=fillStartC;
  positionFillHandle(fillStartR,fillStartC);
});

// ── Column / Row Resize ───────────────────────────────────────────────────────
var _resizingCol=-1,_resizingRow=-1,_resizeStartX=0,_resizeStartY=0,_resizeStartSize=0;
function startColResize(e,c){if(editMode&&_activeInp&&_activeInp.value.startsWith('='))return;_resizingCol=c;_resizeStartX=e.clientX;_resizeStartSize=colWidths[c]||82;e.preventDefault();e.stopPropagation();document.body.style.cursor='col-resize';}
function startRowResize(e,r){if(editMode&&_activeInp&&_activeInp.value.startsWith('='))return;_resizingRow=r;_resizeStartY=e.clientY;_resizeStartSize=rowHeights[r]||22;e.preventDefault();e.stopPropagation();document.body.style.cursor='row-resize';}
// ── Formula drag — document-level mousemove (reliable across fast moves) ──────
document.addEventListener('mousemove',function(e){
  if(!editMode||!_activeInp||!_activeInp.value.startsWith('=')||e.buttons!==1||!_formulaSel) return;
  e.preventDefault();
  var els=document.elementsFromPoint(e.clientX,e.clientY);
  var td=null;
  for(var i=0;i<els.length;i++){if(els[i].classList&&els[i].classList.contains('dc')){td=els[i];break;}}
  if(!td) return;
  var parts=td.id.split('-');
  if(parts.length<3) return;
  var hoverR=parseInt(parts[1]),hoverC=parseInt(parts[2]);
  if(isNaN(hoverR)||isNaN(hoverC)) return;
  _formulaSelEnd={r:hoverR,c:hoverC};
  var r1=Math.min(_formulaSel.r,hoverR),r2=Math.max(_formulaSel.r,hoverR);
  var c1=Math.min(_formulaSel.c,hoverC),c2=Math.max(_formulaSel.c,hoverC);
  var ref=(r1===r2&&c1===c2)?cellId(r1,c1):cellId(r1,c1)+':'+cellId(r2,c2);
  var cur=_activeInp.value;
  var newVal=cur.replace(/[A-Z]+\d+(:[A-Z]+\d+)?$/,ref);
  if(newVal!==cur){
    _activeInp.value=newVal;
    document.getElementById('formula-input').value=newVal;
    // Also show truncated ref in the cell display div
    var dv=document.getElementById('d-'+_activeR+'-'+_activeC);
    if(dv&&!dv.querySelector('input')){dv.textContent=newVal;}
  }
  showFormulaSel(r1,c1,r2,c2);
});

document.addEventListener('mousemove',function(e){
  if(editMode&&_activeInp&&_activeInp.value.startsWith('='))return;
  if(_resizingCol>=0){
    var nw=Math.max(28,_resizeStartSize+(e.clientX-_resizeStartX));colWidths[_resizingCol]=nw;
    var th=document.getElementById('ch-'+_resizingCol);if(th){th.style.width=nw+'px';th.style.minWidth=nw+'px';}
    for(var r=0;r<ROWS;r++){var td=document.getElementById('c-'+r+'-'+_resizingCol);if(td)td.style.width=nw+'px';}
  }
  if(_resizingRow>=0){
    var nh=Math.max(14,_resizeStartSize+(e.clientY-_resizeStartY));rowHeights[_resizingRow]=nh;
    var tr=document.getElementById('tr-'+_resizingRow);if(tr)tr.style.height=nh+'px';
    for(var c=0;c<COLS;c++){var td=document.getElementById('c-'+_resizingRow+'-'+c);if(td)td.style.height=nh+'px';}
  }
});
document.addEventListener('mouseup',function(e){
  if(_resizingCol>=0||_resizingRow>=0){_resizingCol=-1;_resizingRow=-1;document.body.style.cursor='';markUnsaved();}
});

// ── Multi-Sheet Tabs ──────────────────────────────────────────────────────────
function renderSheetTabs(){
  var bar=document.getElementById('sheet-tab-bar');if(!bar)return;
  bar.innerHTML='';
  sheets.forEach(function(sh,i){
    var btn=document.createElement('button');
    btn.className='sheet-tab'+(i===activeSheet?' active':'');
    btn.textContent=sh.name;
    btn.ondblclick=function(){renameSheetPrompt(i);};
    btn.onclick=function(){switchSheet(i);};
    bar.appendChild(btn);
  });
  var addBtn=document.createElement('button');addBtn.className='sheet-tab-add';addBtn.textContent='+';addBtn.title='Add Sheet';addBtn.onclick=addSheet;bar.appendChild(addBtn);
}
function switchSheet(i){
  commitEdit();
  activeSheet=i;bindSheet();
  renderAll();renderSheetTabs();
  selectCell(0,0);
  document.getElementById('sb-mode').textContent='Sheet: '+sheets[i].name;
}
function addSheet(){
  var name='Sheet'+(sheets.length+1);
  sheets.push({name,data:{},cellFmt:{},cellStyle:{},cellComments:{},lockedCells:new Set(),namedRanges:{},colWidths:{},rowHeights:{}});
  switchSheet(sheets.length-1);markUnsaved();
}
function renameSheetPrompt(i){
  var n=prompt('Rename sheet:',sheets[i].name);if(n&&n.trim())sheets[i].name=n.trim();renderSheetTabs();markUnsaved();
}
function deleteActiveSheet(){
  if(sheets.length<=1){alert('Cannot delete the only sheet.');return;}
  if(!confirm('Delete sheet "'+sheets[activeSheet].name+'"?'))return;
  sheets.splice(activeSheet,1);
  activeSheet=Math.max(0,activeSheet-1);bindSheet();renderAll();renderSheetTabs();markUnsaved();
}
function duplicateActiveSheet(){
  var src=sheets[activeSheet];
  var copy={name:src.name+' (2)',data:Object.assign({},src.data),cellFmt:Object.assign({},src.cellFmt),
    cellStyle:Object.assign({},src.cellStyle),cellComments:Object.assign({},src.cellComments),
    lockedCells:new Set(src.lockedCells),namedRanges:Object.assign({},src.namedRanges),
    colWidths:Object.assign({},src.colWidths),rowHeights:Object.assign({},src.rowHeights)};
  sheets.splice(activeSheet+1,0,copy);switchSheet(activeSheet+1);markUnsaved();
}

// ── Dark Mode ─────────────────────────────────────────────────────────────────
function toggleDarkMode(){
  darkMode=!darkMode;
  document.body.classList.toggle('dark',darkMode);
  document.getElementById('btn-darkmode')&&document.getElementById('btn-darkmode').classList.toggle('active',darkMode);
  document.getElementById('sb-mode').textContent=darkMode?'Dark Mode ON':'Dark Mode OFF';
}

// ── CSV Import ────────────────────────────────────────────────────────────────
function importCsvContent(content){
  if(!confirm('Import CSV? This will add data to current sheet from row 1.'))return;
  var lines=content.split('\n');
  lines.forEach(function(line,r){
    if(r>=ROWS||!line.trim())return;
    var cols=line.split(',');
    cols.forEach(function(v,c){if(c<COLS)setRaw(r,c,v.replace(/^"|"$/g,'').trim());});
  });
  renderAll();document.getElementById('sb-mode').textContent='CSV imported ('+lines.length+' rows)';
}

// ── Keyboard Shortcuts Modal ──────────────────────────────────────────────────
function showShortcuts(){
  var shortcuts=[
    ['Ctrl+S','Save'],['Ctrl+Shift+S','Save As'],['Ctrl+O','Open'],['Ctrl+N','New File'],
    ['Ctrl+I','Import CSV'],['Ctrl+P','Print / PDF'],['Ctrl+Z','Undo'],['Ctrl+Y','Redo'],
    ['Ctrl+C','Copy'],['Ctrl+X','Cut'],['Ctrl+V','Paste'],['Ctrl+F','Find'],['Ctrl+H','Replace'],
    ['Ctrl+A','Select All'],['Ctrl+=','Zoom In'],['Ctrl+-','Zoom Out'],['Ctrl+0','Reset Zoom'],
    ['Ctrl+Shift+D','Toggle Dark Mode'],['Ctrl+Shift+N','New Sheet'],
    ['F2','Edit Cell'],['Delete','Clear Cell'],['Enter','Confirm & Down'],['Tab','Confirm & Right'],
    ['Arrow Keys','Navigate'],['PageUp/Down','Move 20 rows'],['Home/End','First/Last column'],
    ['Double-click','Edit Cell']
  ];
  var html='<table style="width:100%;border-collapse:collapse;font-size:11px">';
  shortcuts.forEach(function(s){html+='<tr><td style="padding:4px 8px;border-bottom:1px solid #eee;font-family:Consolas,monospace;background:#f5f5f5;width:140px">'+s[0]+'</td><td style="padding:4px 8px;border-bottom:1px solid #eee">'+s[1]+'</td></tr>';});
  html+='</table>';
  document.getElementById('shortcut-content').innerHTML=html;
  openModal('modal-shortcuts');
}

// ── Enhanced IPC ──────────────────────────────────────────────────────────────
window.electronAPI.onNew(function(){
  if(unsaved&&!confirm('Unsaved changes. Continue?'))return;
  sheets=[{name:'Sheet1',data:{},cellFmt:{},cellStyle:{},cellComments:{},lockedCells:new Set(),namedRanges:{},colWidths:{},rowHeights:{}}];
  activeSheet=0;bindSheet();sheetProtected=false;
  renderAll();renderSheetTabs();currentFilePath=null;
  document.getElementById('file-name').textContent='— Book1';document.getElementById('save-status').textContent='';unsaved=false;
  document.getElementById('sb-mode').textContent='Ready';
});
// ── XLSX Import via SheetJS ───────────────────────────────────────────────────
function importXlsx(base64Content){
  var XLSX = require('xlsx');
  var wb = XLSX.read(base64Content, {
    type: 'base64',
    cellStyles: true,    // read fill/font/border
    cellFormula: true,   // read formulas as .f
    cellDates: true,     // parse dates
    cellNF: true         // read number formats
  });

  sheets = [];

  wb.SheetNames.forEach(function(shName){
    var ws = wb.Sheets[shName];
    var shData = {}, shFmt = {}, shStyle = {};

    if(!ws['!ref']){
      sheets.push({name:shName,data:{},cellFmt:{},cellStyle:{},
        cellComments:{},lockedCells:new Set(),namedRanges:{},colWidths:{},rowHeights:{}});
      return;
    }

    var range = XLSX.utils.decode_range(ws['!ref']);

    for(var r = range.s.r; r <= range.e.r; r++){
      for(var c = range.s.c; c <= range.e.c; c++){
        var addr = XLSX.utils.encode_cell({r:r, c:c});
        var cell = ws[addr];
        if(!cell) continue;

        var id = cellId(r, c);

        // ── Value / Formula ────────────────────────────────────────────────
        if(cell.f){
          shData[id] = '=' + cell.f;
        } else if(cell.v !== undefined && cell.v !== null && cell.v !== ''){
          shData[id] = String(cell.w || cell.v);  // prefer formatted value
        }

        // ── Number format → cellFmt ────────────────────────────────────────
        var nf = (cell.z || (cell.s && cell.s.numFmt) || '').toLowerCase();
        if(nf.includes('%'))               shFmt[id] = 'percent';
        else if(nf.includes('₹')||nf.includes('inr')) shFmt[id] = 'currency';
        else if(nf.includes('$'))          shFmt[id] = 'usd';
        else if(nf.includes('e+'))         shFmt[id] = 'sci';
        else if(nf.includes('dd/mm')||nf.includes('yyyy')) shFmt[id] = 'date';
        else if(nf.includes('hh:mm'))      shFmt[id] = 'time';
        else if(nf === '0.00')             shFmt[id] = 'number';
        else if(nf === '0')                shFmt[id] = 'integer';

        // ── Cell style → cellStyle ─────────────────────────────────────────
        if(cell.s){
          var s = cell.s;
          var st = {};

          // Font
          if(s.font){
            if(s.font.bold)      st.bold      = true;
            if(s.font.italic)    st.italic    = true;
            if(s.font.underline) st.underline = true;
            if(s.font.strike)    st.strike    = true;
            if(s.font.sz)        st.fontSize  = s.font.sz;
            if(s.font.name)      st.fontFamily= s.font.name;
            if(s.font.color && s.font.color.rgb)
              st.color = '#' + s.font.color.rgb.slice(-6);
          }

          // Fill
          if(s.fill && s.fill.fgColor && s.fill.fgColor.rgb &&
             s.fill.fgColor.rgb !== 'FFFFFF' && s.fill.fgColor.rgb !== '000000'){
            var rgb = s.fill.fgColor.rgb.slice(-6);
            if(rgb && rgb !== 'FFFFFF') st.bg = '#' + rgb;
          }

          // Alignment
          if(s.alignment){
            if(s.alignment.horizontal) st.align   = s.alignment.horizontal;
            if(s.alignment.wrapText)   st.wrap    = true;
          }

          // Borders — store as CSS string "1px solid #rrggbb"
          var borderSides = {top:'bt', bottom:'bb', left:'bl', right:'br'};
          Object.keys(borderSides).forEach(function(side){
            if(s.border && s.border[side] && s.border[side].style){
              var bStyle = s.border[side].style;
              var px = (bStyle === 'medium' || bStyle === 'thick') ? '2px' : '1px';
              var lineStyle = (bStyle === 'dashed') ? 'dashed' :
                              (bStyle === 'dotted') ? 'dotted' : 'solid';
              var col = '#000000';
              if(s.border[side].color && s.border[side].color.rgb)
                col = '#' + s.border[side].color.rgb.slice(-6);
              st[borderSides[side]] = px + ' ' + lineStyle + ' ' + col;
            }
          });

          if(Object.keys(st).length) shStyle[id] = st;
        }
      }
    }

    // Column widths (Excel wch units → pixels: multiply by ~7)
    var colWidths = {};
    if(ws['!cols']){
      ws['!cols'].forEach(function(col, i){
        if(col && col.wch) colWidths[i] = Math.round(col.wch * 7);
      });
    }

    sheets.push({
      name: shName,
      data: shData,
      cellFmt: shFmt,
      cellStyle: shStyle,
      cellComments: {},
      lockedCells: new Set(),
      namedRanges: {},
      colWidths: colWidths,
      rowHeights: {}
    });
  });

  if(!sheets.length){
    sheets = [{name:'Sheet1',data:{},cellFmt:{},cellStyle:{},
      cellComments:{},lockedCells:new Set(),namedRanges:{},colWidths:{},rowHeights:{}}];
  }

  activeSheet = 0;
  bindSheet();
}

window.electronAPI.onOpen(function(arg){
  try {
    // Fully clear state before loading
    sheets=[{name:'Sheet1',data:{},cellFmt:{},cellStyle:{},cellComments:{},lockedCells:new Set(),namedRanges:{},colWidths:{},rowHeights:{}}];
    activeSheet=0; bindSheet(); sheetProtected=false;

    var ext=(arg.filePath||'').split('.').pop().toLowerCase();

    if(ext==='csv'){
      importCsvContent(arg.content);
    } else if(ext==='xlsx'||ext==='xls'){
      importXlsx(arg.content);
    } else {
      loadState(arg.content);
    }

    currentFilePath=arg.filePath;
    document.getElementById('file-name').textContent='— '+arg.filePath.split(/[\\/]/).pop();
    renderAll();
    renderSheetTabs();
    selectCell(0,0);
    markSaved();
  } catch(err){
    alert('Error opening file: '+err.message);
  }
});
window.electronAPI.onSave(function(){
  if(!currentFilePath){
    // No file path yet — trigger Save As
    window.electronAPI.triggerSaveAs();
    return;
  }
  var ext=currentFilePath.split('.').pop().toLowerCase();
  if(ext==='xlsx'||ext==='xls'){exportXlsx(currentFilePath);}
  else if(ext==='csv'){window.electronAPI.writeFile({filePath:currentFilePath,content:exportCsv()});}
  else{window.electronAPI.writeFile({filePath:currentFilePath,content:getState()});}
});
window.electronAPI.onSaveAs(function(fp){
  if(!fp)return;
  var ext=fp.split('.').pop().toLowerCase();
  currentFilePath=fp;
  document.getElementById('file-name').textContent='— '+fp.split(/[\\/]/).pop();
  if(ext==='xlsx'||ext==='xls'){exportXlsx(fp);}
  else if(ext==='csv'){window.electronAPI.writeFile({filePath:fp,content:exportCsv()});}
  else{window.electronAPI.writeFile({filePath:fp,content:getState()});}
});
window.electronAPI.onExportCsv(function(fp){window.electronAPI.writeFile({filePath:fp,content:exportCsv()});});
window.electronAPI.onImportCsv(function(arg){importCsvContent(arg.content);});
window.electronAPI.onWriteDone(function(r){if(r.success)markSaved();else alert('Save failed: '+r.error);});
window.electronAPI.onUndo(doUndo);window.electronAPI.onRedo(doRedo);
window.electronAPI.onZoomIn(function(){zoomChange(10);});
window.electronAPI.onZoomOut(function(){zoomChange(-10);});
window.electronAPI.onZoomReset(zoomReset);
window.electronAPI.onGridlines(toggleGridlines);
window.electronAPI.onDarkMode(toggleDarkMode);
window.electronAPI.onSelectAll(function(){rangeStart={r:0,c:0};rangeEnd={r:ROWS-1,c:COLS-1};applyRange();});
window.electronAPI.onAddSheet(addSheet);
window.electronAPI.onRenameSheet(function(){renameSheetPrompt(activeSheet);});
window.electronAPI.onDeleteSheet(deleteActiveSheet);
window.electronAPI.onDuplicateSheet(duplicateActiveSheet);
window.electronAPI.onShortcuts(showShortcuts);
window.electronAPI.onFindReplace(function(){openModal('modal-find');});
window.electronAPI.onAutoSave(function(){if(currentFilePath)window.electronAPI.autoSaveData(currentFilePath,getState());});
// ── Init ──────────────────────────────────────────────────────────────────────
buildGrid();
renderSheetTabs();
selectCell(0,0);
setOrientation('portrait');
