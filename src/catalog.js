import {retailPlans} from '../public/plans.js';
export const plans = retailPlans;
export const uid = () => crypto.randomUUID();
const styles = [
  ['Canvas Field Jacket','JKT','field-jacket','Outerwear',5999,2600,'Olive'],
  ['Everyday Cotton Tee','TEE','everyday-tee','T-shirts',2400,900,'Cloud'],
  ['Essential Canvas Tote','TOT','canvas-tote','Accessories',1800,610,'Natural'],
  ['Merino Crewneck','KNT','knit-sweater','Knitwear',6500,2500,'Camel'],
  ['Cotton Twill Cap','CAP','baseball-cap','Accessories',2200,750,'Navy'],
  ['Straight Leg Denim','DEN','denim-jeans','Denim',7200,3200,'Indigo'],
  ['Leather Card Wallet','WLT','leather-wallet','Accessories',3500,1400,'Tan'],
  ['Classic Oxford Shirt','OXF','oxford-shirt','Shirts',4800,2150,'Sky'],
  ['Ribbed Knit Beanie','BNE','knit-beanie','Accessories',2000,750,'Charcoal']
];
export function newWorkspace(name, storeName, demo=false) {
  const stores=[{id:'london',name:storeName,address:''}];
  if(demo) stores.push({id:'manchester',name:'Manchester',address:'Northern Quarter'});
  const s={name,stores,demo,plan:demo?'Growth':'Starter',trialEnd:Date.now()+14*86400000,billing:'trial',vat:20,inclusive:true,products:[],orders:[],movements:[],customers:[],suppliers:[],purchaseOrders:[],events:[],audit:[],brand:'',sequence:1000};
  if(!demo)return s;
  s.customers=['Amelia Brooks','Oliver Bennett','Sophie Clarke','James Wilson','Isla Patel','Noah Evans','Mia Collins','Leo Harrison','Ava Taylor','Theo Grant'].map((name,i)=>({id:'c'+i,name,email:name.toLowerCase().replace('','').replace(' ','.')+'@example.com',phone:'',consent:false}));
  s.suppliers=['Northline Garments','Fieldwork Textiles','Alder Goods'].map((name,i)=>({id:'v'+i,name,email:'orders@example.com'}));
  for(let i=0;i<styles.length;i++){
    const [name,prefix,photo,category,price,cost,color]=styles[i];
    const sizes=category==='Accessories'?['One size']:['M','S','L','XL'];
    sizes.forEach((size,j)=>{
      const id=prefix+'-'+String(j+1).padStart(3,'0');
      const stock={london:i===0&&j===0?10:(i*7+j*11)%38+2,manchester:(i*9+j*3)%31+3};
      s.products.push({id,sku:id,barcode:'5051100'+String(i*10+j).padStart(6,'0'),name,category,size,color,photo,price,cost,threshold:i===0?9:5,stock,tax:20});
    });
  }
  let random=74;
  function rand(){random=(Math.imul(1664525,random)+1013904223)>>>0;return random/4294967296}
  const now=new Date();now.setUTCHours(0,0,0,0);
  for(let d=89;d>=0;d--){
    const n=Math.round(9+rand()*8+Math.sin(d*1.3)*3+(89-d)*.07);
    for(let j=0;j<n;j++){
      const prod=s.products[Math.floor(rand()*s.products.length)],qty=1+Math.floor(rand()*3);
      const channel=['In-store','Online store','Click & collect'][rand()<.66?0:rand()<.72?1:2];
      const order={id:'ORD-'+(++s.sequence),date:now.getTime()-d*86400000+Math.floor((d===0?(Date.now()-now.getTime()):(.78*86400000))*((j+1)/(n+1))),store:rand()<.68?'london':'manchester',customer:rand()<.78?s.customers[Math.floor(rand()*10)].id:'',channel,method:channel==='In-store'&&rand()<.35?'Cash':'Card',status:rand()<.035?'Refunded':'Paid',items:[{id:prod.id,name:prod.name,sku:prod.sku,qty,price:prod.price,cost:prod.cost}],total:prod.price*qty,discount:0,tax:Math.round(prod.price*qty/6),operator:'Jamie Parker',seed:true};
      s.orders.push(order)
    }
  }
  // Seed history is generated deterministically for each demo, then persisted.
  s.billing='demo';
  return s;
}
