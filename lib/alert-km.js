'use strict';

function kilometersConflict(a,b) {
  if (a == null || b == null || a === '' || b === '') return false;
  const first=Number(a), second=Number(b);
  return Number.isFinite(first) && Number.isFinite(second) && Math.abs(first-second)>1;
}

module.exports={ kilometersConflict };
