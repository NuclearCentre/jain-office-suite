const { ipcRenderer } = require('electron');
const fs = require('fs');

const COLS = 52, ROWS = 500;

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
  renderCell(r,c);markUnsaved();
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
      .replace(/\bAVERAGEIF\(/g,'__averageif(').replace(/\bCOUNTIFS\(/g,'__countifs(');
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
    function __countif(range,crit){var vals=[].slice.call(arguments,0,arguments.length-1).flat();var c=String(crit);return vals.filter(function(v){return String(v)===c;}).length;}
    function __sumif(range,crit,sumRange){var vals=[].slice.call(arguments,0,arguments.length-1).flat();var c=String(crit);var s=0;vals.forEach(function(v){if(String(v)===c)s+=parseFloat(v)||0;});return s;}
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
    function __averageif(range,crit){var vals=[].slice.call(arguments,0,arguments.length-1).flat();var c=String(crit);var m=vals.filter(function(v){return String(v)===c;});return m.length?m.reduce(function(s,v){return s+(parseFloat(v)||0);},0)/m.length:0;}
    function __countifs(){return 0;}
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
  if(s.wrap)css+='white-space:normal;line-height:1.4;height:auto;overflow:visible;';
  el.style.cssText=css;
  var cell=document.getElementById('c-'+r+'-'+c);
  if(cell){
    if(s.bg)cell.style.background=s.bg;
    else if(!cell.classList.contains('tbl-h')&&!cell.classList.contains('tbl-a'))cell.style.background='';
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
    (function(cc){var rz=document.createElement('div');rz.style.cssText='position:absolute;right:0;top:0;width:4px;height:100%;cursor:col-resize;z-index:5;';rz.addEventListener('mousedown',function(e){startColResize(e,cc);});th.appendChild(rz);})(c);
    hr.appendChild(th);
  }
  thead.appendChild(hr);table.appendChild(thead);
  var tbody=document.createElement('tbody');
  for(var r=0;r<ROWS;r++){
    var tr=document.createElement('tr');tr.id='tr-'+r;var rh2=rowHeights[r]||22;tr.style.height=rh2+'px';
    var rh=document.createElement('th');rh.className='ch rh';rh.id='rh-'+r;rh.style.position='relative';rh.style.width='52px';rh.style.minWidth='52px';
    rh.innerHTML='<span style="pointer-events:none">'+(r+1)+'</span>';
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
          commitEdit();startSel(rr,cc,e);
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
          // Formula drag is handled by document mousemove below — skip here
          if(editMode && _activeInp && _activeInp.value.startsWith('=') && e.buttons===1) return;
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
  {name:'ISTEXT',sig:'ISTEXT(value)',desc:'Returns TRUE if value is text.'}
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
  _acSig.style.left = rect.left + 'px';
  _acSig.style.top  = (rect.bottom + 2) + 'px';
  _acSig.style.display = 'block';
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
  inp.addEventListener('blur',function(){setTimeout(function(){if(editMode&&_activeR===r&&_activeC===c){hideAc();commitEdit();}},120);});
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
  // Clear per-cell classes — we use overlay only
  document.querySelectorAll('.dc.formula-sel').forEach(function(el){el.classList.remove('formula-sel');});
  var fo=document.getElementById('formula-overlay');
  if(!fo) return;
  var tl=document.getElementById('c-'+r1+'-'+c1);
  var br=document.getElementById('c-'+r2+'-'+c2);
  if(!tl||!br){fo.style.display='none';return;}
  var cont=document.getElementById('grid-container');
  var cr=cont.getBoundingClientRect();
  var tlr=tl.getBoundingClientRect();
  var brr=br.getBoundingClientRect();
  fo.style.display='block';
  fo.style.left  =(tlr.left - cr.left + cont.scrollLeft)+'px';
  fo.style.top   =(tlr.top  - cr.top  + cont.scrollTop )+'px';
  fo.style.width =(brr.right  - tlr.left)+'px';
  fo.style.height=(brr.bottom - tlr.top )+'px';
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
  ov.style.left=(tlr.left-cr.left+cont.scrollLeft)+'px';
  ov.style.top=(tlr.top-cr.top+cont.scrollTop)+'px';
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
// ── Color Picker ─────────────────────────────────────────────────────────────
var _colorPickerTarget = null; // 'font' or 'fill'
var _colorPickerEl = null;

var COLOR_PALETTE = [
  // Row 1 - dark
  '#000000','#1a1a1a','#333333','#4d4d4d','#666666','#808080','#999999','#b3b3b3','#cccccc','#ffffff',
  // Row 2 - reds/oranges
  '#c0392b','#e74c3c','#e67e22','#f39c12','#f1c40f','#d4ac0d','#a04000','#6e2f1a','#922b21','#7b241c',
  // Row 3 - greens
  '#1e6e3a','#27ae60','#2ecc71','#1abc9c','#16a085','#0e6655','#196f3d','#239b56','#a9dfbf','#d5f5e3',
  // Row 4 - blues
  '#1565c0','#2980b9','#3498db','#5dade2','#85c1e9','#1a5276','#154360','#2471a3','#aed6f1','#d6eaf8',
  // Row 5 - purples/pinks
  '#6c3483','#8e44ad','#9b59b6','#d7bde2','#e8daef','#c0392b','#e91e63','#f06292','#f8bbd0','#fce4ec'
];

function openFontColor(btnEl){
  showColorPicker(btnEl || event.currentTarget, 'font');
}
function openFillColor(btnEl){
  showColorPicker(btnEl || event.currentTarget, 'fill');
}

function showColorPicker(anchorEl, target){
  // Remove any existing picker
  closeColorPicker();
  _colorPickerTarget = target;

  var picker = document.createElement('div');
  picker.id = 'color-picker-popup';
  picker.style.cssText = [
    'position:fixed',
    'background:#fff',
    'border:1px solid #ccc',
    'border-radius:6px',
    'box-shadow:0 4px 16px rgba(0,0,0,0.22)',
    'z-index:99999',
    'padding:10px',
    'width:196px',
    'user-select:none'
  ].join(';');

  // Title
  var title = document.createElement('div');
  title.style.cssText = 'font-size:10px;font-weight:bold;color:#555;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px';
  title.textContent = target === 'font' ? 'Font Color' : 'Fill Color';
  picker.appendChild(title);

  // Palette grid
  var grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(10,16px);gap:2px;margin-bottom:8px';

  COLOR_PALETTE.forEach(function(hex){
    var swatch = document.createElement('div');
    swatch.style.cssText = [
      'width:16px',
      'height:16px',
      'border-radius:2px',
      'cursor:pointer',
      'background:'+hex,
      'border:1px solid rgba(0,0,0,0.15)',
      'box-sizing:border-box'
    ].join(';');
    swatch.title = hex;
    swatch.addEventListener('mouseenter', function(){
      swatch.style.transform = 'scale(1.25)';
      swatch.style.zIndex = '2';
      swatch.style.position = 'relative';
    });
    swatch.addEventListener('mouseleave', function(){
      swatch.style.transform = '';
      swatch.style.zIndex = '';
      swatch.style.position = '';
    });
    swatch.addEventListener('mousedown', function(e){
      e.preventDefault();
      applyColorPickerValue(hex);
    });
    grid.appendChild(swatch);
  });
  picker.appendChild(grid);

  // Divider
  var div = document.createElement('div');
  div.style.cssText = 'border-top:1px solid #eee;margin:4px 0 8px';
  picker.appendChild(div);

  // Custom color row
  var customRow = document.createElement('div');
  customRow.style.cssText = 'display:flex;align-items:center;gap:8px';

  var customLabel = document.createElement('span');
  customLabel.style.cssText = 'font-size:10px;color:#555;white-space:nowrap';
  customLabel.textContent = 'Custom:';

  var customInput = document.createElement('input');
  customInput.type = 'color';
  customInput.value = '#000000';
  customInput.style.cssText = 'width:32px;height:22px;border:1px solid #ccc;border-radius:3px;cursor:pointer;padding:0 2px';

  var customApply = document.createElement('button');
  customApply.textContent = 'Apply';
  customApply.style.cssText = [
    'padding:3px 8px',
    'font-size:10px',
    'background:#1e6e3a',
    'color:#fff',
    'border:none',
    'border-radius:3px',
    'cursor:pointer',
    'flex:1'
  ].join(';');
  customApply.addEventListener('mousedown', function(e){
    e.preventDefault();
    applyColorPickerValue(customInput.value);
  });

  // Also apply on Enter in custom input
  customInput.addEventListener('change', function(){
    applyColorPickerValue(customInput.value);
  });

  // Clear color option
  var clearBtn = document.createElement('button');
  clearBtn.textContent = 'None';
  clearBtn.style.cssText = [
    'padding:3px 6px',
    'font-size:10px',
    'background:#f5f5f5',
    'color:#333',
    'border:1px solid #ccc',
    'border-radius:3px',
    'cursor:pointer'
  ].join(';');
  clearBtn.addEventListener('mousedown', function(e){
    e.preventDefault();
    applyColorPickerValue('');
  });

  customRow.appendChild(customLabel);
  customRow.appendChild(customInput);
  customRow.appendChild(customApply);
  customRow.appendChild(clearBtn);
  picker.appendChild(customRow);

  document.body.appendChild(picker);
  _colorPickerEl = picker;

  // Position below the anchor button
  var rect = anchorEl ? anchorEl.getBoundingClientRect() : {left:200, bottom:80};
  var left = rect.left;
  var top  = rect.bottom + 4;
  // Keep on screen
  if(left + 206 > window.innerWidth)  left = window.innerWidth - 210;
  if(top  + 260 > window.innerHeight) top  = rect.top - 264;
  picker.style.left = left + 'px';
  picker.style.top  = top  + 'px';

  // Close on outside click
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
    if(hex) applyStyleProp('color', hex);
    else applyStyleProp('color', '');
  } else {
    if(hex) applyStyleProp('bg', hex);
    else applyStyleProp('bg', '');
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
  for(var c=c1;c<=c2;c++){var el=document.getElementById('c-'+r1+'-'+c);if(el)el.classList.add('tbl-h');if(!getRaw(r1,c))setRaw(r1,c,'Header '+(c-c1+1));}
  for(var r=r1+1;r<=r2;r++)for(var c=c1;c<=c2;c++){var el=document.getElementById('c-'+r+'-'+c);if(el)el.classList.add((r-r1)%2===0?'tbl-a':'');}
}
function insertAutoSum(){var s='=SUM('+cellId(Math.max(0,selR-5),selC)+':'+cellId(selR-1,selC)+')';setRaw(selR,selC,s);fi.value=s;}
function insertFn(fn){
  closeModal('modal-formula');
  fi.value='='+fn+'(';fi.focus();
  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active');});
  document.querySelectorAll('.tab-content').forEach(function(t){t.classList.remove('active');});
  document.querySelector('[data-tab="formulas"]').classList.add('active');
  document.getElementById('tab-formulas').classList.add('active');
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
  closeModal('modal-dataval');
  document.getElementById('sb-mode').textContent='Validation set for '+cellId(selR,selC);
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
    frozenRows=selR;frozenCols=selC;
    document.getElementById('btn-freeze').classList.add('active');
    document.getElementById('sb-mode').textContent='Frozen at '+cellId(selR,selC);
  }else{
    frozenRows=0;frozenCols=0;
    document.getElementById('btn-freeze').classList.remove('active');
    document.getElementById('sb-mode').textContent='Panes unfrozen';
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
  var gw=document.getElementById('grid-wrap');
  gw.style.transform='scale('+v/100+')';gw.style.transformOrigin='top left';
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
    ipcRenderer.send('write-file', {filePath: filePath, content: buf, isBuffer: true});
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
      setRaw(r,fillStartC,String(baseVal+(r-fillStartR)));
    }
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
function startColResize(e,c){_resizingCol=c;_resizeStartX=e.clientX;_resizeStartSize=colWidths[c]||82;e.preventDefault();e.stopPropagation();document.body.style.cursor='col-resize';}
function startRowResize(e,r){_resizingRow=r;_resizeStartY=e.clientY;_resizeStartSize=rowHeights[r]||22;e.preventDefault();e.stopPropagation();document.body.style.cursor='row-resize';}
// ── Formula drag — document-level mousemove (reliable across fast moves) ──────
document.addEventListener('mousemove',function(e){
  if(!editMode||!_activeInp||!_activeInp.value.startsWith('=')||e.buttons!==1||!_formulaSel) return;
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
  if(newVal!==cur){_activeInp.value=newVal;document.getElementById('formula-input').value=newVal;}
  showFormulaSel(r1,c1,r2,c2);
});

document.addEventListener('mousemove',function(e){
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
ipcRenderer.on('menu-new',function(){
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

ipcRenderer.on('menu-open',function(e,arg){
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
ipcRenderer.on('menu-save',function(){
  if(!currentFilePath){
    // No file path yet — trigger Save As
    ipcRenderer.send('trigger-saveas');
    return;
  }
  var ext=currentFilePath.split('.').pop().toLowerCase();
  if(ext==='xlsx'||ext==='xls'){exportXlsx(currentFilePath);}
  else if(ext==='csv'){ipcRenderer.send('write-file',{filePath:currentFilePath,content:exportCsv()});}
  else{ipcRenderer.send('write-file',{filePath:currentFilePath,content:getState()});}
});
ipcRenderer.on('menu-saveas',function(e,fp){
  if(!fp)return;
  var ext=fp.split('.').pop().toLowerCase();
  currentFilePath=fp;
  document.getElementById('file-name').textContent='— '+fp.split(/[\\/]/).pop();
  if(ext==='xlsx'||ext==='xls'){exportXlsx(fp);}
  else if(ext==='csv'){ipcRenderer.send('write-file',{filePath:fp,content:exportCsv()});}
  else{ipcRenderer.send('write-file',{filePath:fp,content:getState()});}
});
ipcRenderer.on('menu-exportcsv',function(e,fp){ipcRenderer.send('write-file',{filePath:fp,content:exportCsv()});});
ipcRenderer.on('menu-importcsv',function(e,arg){importCsvContent(arg.content);});
ipcRenderer.on('write-file-done',function(e,r){if(r.success)markSaved();else alert('Save failed: '+r.error);});
ipcRenderer.on('menu-undo',doUndo);ipcRenderer.on('menu-redo',doRedo);
ipcRenderer.on('menu-zoomin',function(){zoomChange(10);});
ipcRenderer.on('menu-zoomout',function(){zoomChange(-10);});
ipcRenderer.on('menu-zoomreset',zoomReset);
ipcRenderer.on('menu-gridlines',toggleGridlines);
ipcRenderer.on('menu-darkmode',toggleDarkMode);
ipcRenderer.on('menu-selectall',function(){rangeStart={r:0,c:0};rangeEnd={r:ROWS-1,c:COLS-1};applyRange();});
ipcRenderer.on('menu-addsheet',addSheet);
ipcRenderer.on('menu-renamesheet',function(){renameSheetPrompt(activeSheet);});
ipcRenderer.on('menu-deletesheet',deleteActiveSheet);
ipcRenderer.on('menu-duplicatesheet',duplicateActiveSheet);
ipcRenderer.on('menu-shortcuts',showShortcuts);
ipcRenderer.on('menu-findreplace',function(){openModal('modal-find');});
ipcRenderer.on('menu-autosave',function(){if(currentFilePath)ipcRenderer.send('autosave-data',{filePath:currentFilePath,content:getState()});});
// ── Init ──────────────────────────────────────────────────────────────────────
buildGrid();
renderSheetTabs();
selectCell(0,0);
setOrientation('portrait');
