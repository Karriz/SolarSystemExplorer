/** Seamless 3D noise; octave weights depend on pixel footprint, so close detail
 * disappears continuously before it aliases. No longitude/polar texture UVs. */
export const appearanceNoise = /* glsl */`
  float hash31(vec3 p) {
    p=fract(p*0.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);
  }
  float noise3(vec3 p) {
    vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
    return mix(mix(mix(hash31(i),hash31(i+vec3(1,0,0)),f.x),
      mix(hash31(i+vec3(0,1,0)),hash31(i+vec3(1,1,0)),f.x),f.y),
      mix(mix(hash31(i+vec3(0,0,1)),hash31(i+vec3(1,0,1)),f.x),
      mix(hash31(i+vec3(0,1,1)),hash31(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
  float filteredFbm(vec3 p) {
    float result=0.0,weight=0.5333333;
    float footprint=max(length(dFdx(p)),length(dFdy(p)));
    for(int i=0;i<4;i++) {
      float visible=1.0-smoothstep(0.25,0.75,footprint);
      result+=weight*(mix(0.5,noise3(p),visible)-0.5);
      p=p*2.03+vec3(11.7,3.1,7.8);footprint*=2.03;weight*=0.5;
    }
    return result;
  }
`
