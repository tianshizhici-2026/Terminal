// Keep the user's blinking cursor preference while preserving application cursor shapes.
export function keepCursorBlinking(term) {
  term.parser.registerCsiHandler({intermediates:' ',final:'q'},params=>{
    const style=params[0]??0;
    if(typeof style!=='number'||style<0||style>6)return false;
    term.options.cursorStyle=style===0?'bar':style<=2?'block':style<=4?'underline':'bar';
    term.options.cursorBlink=true;
    return true;
  });
  // DEC mode 12 and terminal reset sequences can also change the preference.
  term.onWriteParsed(()=>{if(!term.options.cursorBlink)term.options.cursorBlink=true;});
}
