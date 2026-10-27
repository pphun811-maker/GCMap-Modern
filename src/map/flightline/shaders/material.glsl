vec3 material_colour(vec3 field, float lat, float elev, float style, float dark, float muted, float lift) {
    float forest = smootherstep(0.04, 0.78, field.r);
    float herbaceous = smootherstep(0.05, 0.78, field.g);
    float wet = smootherstep(0.02, 0.86, max((0.5 - field.b) * 2.0, 0.0));
    float dry = smootherstep(0.02, 0.86, max((field.b - 0.5) * 2.0, 0.0));
    float abs_lat = abs(lat);
    float tropical = 1.0 - smootherstep(radians(20.0), radians(36.0), abs_lat);
    float boreal = smootherstep(radians(48.0), radians(68.0), abs_lat);
    vec3 neutral = mix(vec3(0.37, 0.55, 0.33), vec3(0.30, 0.51, 0.38), boreal);
    vec3 forest_c = mix(vec3(0.14, 0.46, 0.25), vec3(0.185, 0.43, 0.32), boreal);
    forest_c = mix(forest_c, vec3(0.09, 0.42, 0.22), tropical);
    vec3 herb_c = mix(vec3(0.43, 0.62, 0.32), vec3(0.35, 0.56, 0.36), boreal);
    vec3 wet_c = mix(vec3(0.20, 0.48, 0.36), vec3(0.13, 0.45, 0.30), tropical);
    vec3 dry_c = mix(vec3(0.78, 0.57, 0.43), vec3(0.74, 0.53, 0.42), boreal);
    float fw = forest * 0.95;
    float hw = herbaceous * 0.85;
    float ww = wet * 0.75;
    float dw = dry * 0.95;
    float total = fw + hw + ww + dw;
    vec3 evidence = (forest_c * fw + herb_c * hw + wet_c * ww + dry_c * dw) / max(total, 0.001);
    vec3 c = mix(neutral, evidence, clamp(total, 0.0, 1.0));
    float highland = smootherstep(0.16, 0.68, elev);
    vec3 stone = mix(vec3(0.53, 0.50, 0.45), vec3(0.49, 0.51, 0.49), boreal);
    c = mix(c, stone, highland * mix(0.38, 0.50, dry));
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(lum), c, mix(0.82, 1.10, style));
    // Orbit lift: from far out the dark theme keeps more of the day colour, so the continents read.
    vec3 dark_c = mix(vec3(lum), c, mix(0.72, ORBIT_LIFT_SAT, lift)) * mix(0.66, ORBIT_LIFT_GAIN, lift) + vec3(0.0, 0.012, 0.022);
    c = mix(c, dark_c, dark);
    float muted_lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return mix(c, mix(vec3(muted_lum), c, 0.58) * 0.94, muted);
}

vec3 ocean_colour(float depth, float style, float dark, float muted) {
    float shelf_to_mid = smootherstep(0.08, 0.40, depth);
    float mid_to_abyss = smootherstep(0.38, 0.82, depth);
    vec3 dark_shelf = mix(vec3(0.085, 0.175, 0.245), vec3(0.065, 0.235, 0.285), style);
    vec3 dark_mid = mix(vec3(0.050, 0.105, 0.190), vec3(0.035, 0.125, 0.220), style);
    vec3 dark_abyss = mix(vec3(0.018, 0.046, 0.115), vec3(0.012, 0.038, 0.105), style);
    vec3 dark_c = mix(mix(dark_shelf, dark_mid, shelf_to_mid), dark_abyss, mid_to_abyss);
    vec3 light_shelf = mix(vec3(0.40, 0.72, 0.84), vec3(0.32, 0.76, 0.79), style);
    vec3 light_mid = mix(vec3(0.24, 0.47, 0.66), vec3(0.18, 0.50, 0.69), style);
    vec3 light_abyss = mix(vec3(0.10, 0.23, 0.42), vec3(0.075, 0.20, 0.40), style);
    vec3 light_c = mix(mix(light_shelf, light_mid, shelf_to_mid), light_abyss, mid_to_abyss);
    vec3 c = mix(light_c, dark_c, dark);
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return mix(c, mix(vec3(lum), c, 0.55) * 0.94, muted);
}

