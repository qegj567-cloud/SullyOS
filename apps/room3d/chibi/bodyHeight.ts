// Shared rest-space height mapping. Feet retain their shape; 84% of added
// ankle-to-neck height goes to the legs. At 100% this is exactly identity.
const scale=1.875/.354;
const ankle=.049*scale,hip=.38*scale,neck=.65*scale;
const legGain=1.65,torsoGain=(neck-(hip-ankle)*legGain)/(neck-hip);
export function bodyHeightSlope(y:number,h:number){return y<=ankle?1:y<=hip?1+legGain*(h-1):1+torsoGain*(h-1);}
export function bodyHeightY(y:number,h:number){
 const leg=1+legGain*(h-1),torso=1+torsoGain*(h-1);
 return y<=ankle?y:y<=hip?ankle+(y-ankle)*leg:ankle+(hip-ankle)*leg+(y-hip)*torso;
}
export function bodyBaseY(y:number,h:number){
 const leg=1+legGain*(h-1),torso=1+torsoGain*(h-1),raisedHip=ankle+(hip-ankle)*leg;
 return y<=ankle?y:y<=raisedHip?ankle+(y-ankle)/leg:hip+(y-raisedHip)/torso;
}
