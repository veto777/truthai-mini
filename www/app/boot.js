/* runs before client.js: restore the saved theme with no flash, and derive the base path from where /app/ is
   mounted (root, /mini, any prefix). External file so the server's CSP can stay script-src 'self' with no inline. */
try{ var _t=localStorage.getItem("tc-theme"); if(_t) document.documentElement.setAttribute("data-theme",_t); }catch(e){}
window.TC_BASE=(location.pathname.replace(/\/app\/.*$/,"")||"");
