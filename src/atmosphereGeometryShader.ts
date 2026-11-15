/** Shared grazing-ray roots and molecular phase in body-relative units.
 * Direction must be normalized. Use cross-product distance near tangency. */
export const atmosphereGeometryShader = /* glsl */`
  vec2 atmGeometrySphere(vec3 p, vec3 d, float r) {
    float b=dot(p,d), disc=r*r-dot(cross(p,d),cross(p,d));
    if(disc<0.0) return vec2(1.0,-1.0);
    float root=sqrt(disc);
    if(root==0.0) return vec2(-b);
    float q=-b-(b<0.0?-root:root);
    float len=length(p), other=(len-r)*(len+r)/q;
    return vec2(min(q,other),max(q,other));
  }
  float atmGeometryRayleighPhase(float mu) { return 3.0*(1.0+mu*mu)/(16.0*3.14159265359); }
`
