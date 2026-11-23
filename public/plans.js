export const retailPlans = {
  Starter: {price:19, stores:1, staff:2},
  Growth: {price:49, stores:3, staff:10},
  Business: {price:99, stores:1000, staff:10000}
};

export function planAllowance(count, unit) {
  return count.toLocaleString('en-GB')+' '+unit+(count===1||unit==='staff'?'':'s');
}
