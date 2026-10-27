#version 300 es
// Round 03 planet overlay. a GLSL ES 3.00 port of reference/planet-original.wgsl
// (FRAGMENT_SHADER_SOURCE / ATMOSPHERE_HALO_FRAGMENT_SHADER_SOURCE).
//
// Kept from the original: terminator LUT composition, golden-hour tint, material and
// ocean colour, classified land confidence, orbit lift, sun-relative terrain relief,
// north-west orbit hillshade, water PBR/glint, city-light bicubic smoothing, twinkle,
// bloom footprint, polar ring means, aerial haze, halo, premultiplied composition.
//
// Deliberate differences (see reports/FIDELITY-MATRIX.md):
//  - Seasonal snow and sea ice are NOT ported. Snow is a stable/perennial mask that
//    needs both the climatology signal (high peak AND almost year-round duration) and
//    vector glacier / ice-sheet support from the shipped z7 basemap, per the user's
//    brief. The snow climatology spans ±90° and uses its own UV and derivative scale
//    (the original's clim_uv), unlike the ±85° material / elevation / lights atlases.
//  - Emitted colours are used in display space: MapLibre's framebuffer is gamma-space,
//    so srgb2lin() from the linear HDR source is omitted.
// Round 03 adds the road-pass handover only: the recovered original value
// LIGHTS_UNDER_ROADS = 0.45 is applied through u_roads_takeover, which the app
// keeps at 0 until the night-road layer has real geometry and is being drawn.
// Round 09 adds u_mid_takeover for the mid-scale network's own handover
// (3.5..5.5, faded back by 7.0). It dims the atlas to 0.62 of full rather than
// the near network's 0.45, because the shipped z4-6 data is an arterial
// skeleton, not a full street grid; the near constant still wins wherever it
// applies. Everything else (LUT, material, ocean, snow, atmosphere) is Round 02
// unchanged.
//  - The terminator LUT alpha ramp is inferred (palette is evidenced; alpha is not).
precision highp float;
precision highp int;

in vec2 v_ndc;
out vec4 fragColor;

uniform mat4 u_inverse;
uniform vec3 u_sun;
uniform vec3 u_center;
uniform float u_globe;
uniform float u_zoom;
uniform float u_detail;
uniform float u_cycle;
uniform float u_lights;
uniform float u_material;
uniform float u_atmosphere;
uniform float u_dark;
uniform float u_compare;
uniform float u_snow;
uniform float u_time_days;
uniform float u_twinkle;
uniform float u_debug;
uniform float u_roads_takeover;
uniform float u_mid_takeover;
uniform float u_atlas_floor;
uniform vec2 u_lights_texel;
uniform vec2 u_elevation_texel;
uniform sampler2D t_lights;
uniform sampler2D t_elevation;
uniform sampler2D t_material;
uniform sampler2D t_snow;
uniform sampler2D t_snow_support;
uniform sampler2D t_lut;

const float PI = 3.141592653589793;
const float MATERIAL_FADE_START = 4.5;
const float MATERIAL_FADE_END = 6.5;
const float ORBIT_LIFT_START = 3.0;
const float ORBIT_LIFT_END = 5.0;
const float ORBIT_LIFT_SAT = 1.08;
const float ORBIT_LIFT_GAIN = 0.98;
const float ORBIT_LIFT_OPACITY = 0.6;
const float ORBIT_RELIEF_GAIN = 4.0;
// Recovered from flglobe.dll: the tile pass's road glow draws the lit network and
// the atlas stays as the unresolved lamps between the roads (0.45 once handed over).
const float LIGHTS_UNDER_ROADS = 0.45;
const float MID_LIGHTS_UNDER_ROADS = 0.38;
// Stable/perennial snow thresholds on the climatology (peak, months). Unit of the
// user's "conservative ice" brief: ice sheets and real glaciers only.
const float SNOW_PEAK_LO = 0.82;
const float SNOW_PEAK_HI = 0.90;
const float SNOW_MONTHS_LO = 10.5;
const float SNOW_MONTHS_HI = 11.5;
const float HALO_SHELL = 1.022;
// Facing at the globe silhouette for that shell: sqrt(1 - 1/shell^2) ~= 0.206.
const float HALO_INNER = 0.21;
const float TERRAIN_STRENGTH = 1.0;

float smootherstep(float a, float b, float x) {
    float t = clamp((x - a) / (b - a), 0.0, 1.0);
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

//__MATERIAL_INCLUDE__

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float hash13(vec3 p) {
    vec3 p3 = fract(p * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}

float value_noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 w = f * f * (3.0 - 2.0 * f);
    float x00 = mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), w.x);
    float x10 = mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), w.x);
    float x01 = mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), w.x);
    float x11 = mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), w.x);
    return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
}

vec4 bspline(float f) {
    float s = f * f;
    float c = s * f;
    return vec4(
        (1.0 - 3.0 * f + 3.0 * s - c) / 6.0,
        (4.0 - 6.0 * s + 3.0 * c) / 6.0,
        (1.0 + 3.0 * f + 3.0 * s - 3.0 * c) / 6.0,
        c / 6.0);
}

float polar_weight(float uv_y) {
    return 1.0 - smootherstep(0.0, 1.5 / 170.0, min(uv_y, 1.0 - uv_y));
}

// Snow climatology and its support mask span the full ±90° sphere. This is a
// separate mapping from the ±85° material / elevation / lights atlases:
// the original uses clim_uv.y=(PI/2-lat)/PI and scales vertical derivatives by
// 170/180 (reference/planet-original.wgsl:606-608), then samples the snow atlas.
vec2 snow_clim_uv(float lat, float lon) {
    return vec2(lon / (2.0 * PI) + 0.5, clamp((PI * 0.5 - lat) / PI, 0.0, 1.0));
}

// Mean of the edge row nearest uv_y at a mip whose texel spans about a degree.
vec4 ring_mean(sampler2D t, float uv_y) {
    float texels = float(textureSize(t, 0).y);
    float lod = max(log2(texels / 170.0), 0.0);
    float v = uv_y < 0.5 ? 0.0 : 1.0;
    vec4 sum = vec4(0.0);
    for (int i = 0; i < 16; i++) {
        sum += textureLod(t, vec2((float(i) + 0.5) / 16.0, v), lod);
    }
    return sum / 16.0;
}

vec4 lights_grad(vec2 uv, vec2 dx, vec2 dy, float pw, vec4 ring) {
    return mix(textureGrad(t_lights, uv, dx, dy), ring, pw);
}

vec4 elevation_at(vec2 uv, vec2 dx, vec2 dy, float pw, vec4 ring) {
    return mix(textureGrad(t_elevation, uv, dx, dy), ring, pw);
}

// Cubic B-spline over a 4x4 footprint in four bilinear taps.
vec4 lights_smooth(vec2 uv, vec2 dx, vec2 dy, float pw, vec4 ring) {
    vec2 ts = u_lights_texel;
    vec2 pos = uv / ts - 0.5;
    vec2 base = floor(pos);
    vec2 f = fract(pos);
    vec4 xw = bspline(f.x);
    vec4 yw = bspline(f.y);
    vec2 xg = vec2(xw.x + xw.y, xw.z + xw.w);
    vec2 yg = vec2(yw.x + yw.y, yw.z + yw.w);
    vec2 sx = vec2(base.x - 0.5 + xw.y / xg.x, base.x + 1.5 + xw.w / xg.y) * ts.x;
    vec2 sy = vec2(base.y - 0.5 + yw.y / yg.x, base.y + 1.5 + yw.w / yg.y) * ts.y;
    vec4 upper = mix(lights_grad(vec2(sx.x, sy.x), dx, dy, pw, ring),
                     lights_grad(vec2(sx.y, sy.x), dx, dy, pw, ring), xg.y);
    vec4 lower = mix(lights_grad(vec2(sx.x, sy.y), dx, dy, pw, ring),
                     lights_grad(vec2(sx.y, sy.y), dx, dy, pw, ring), xg.y);
    return mix(upper, lower, yg.y);
}

vec3 terrain_normal(vec3 base, vec2 uv, vec2 dx, vec2 dy, float lat, float lon, float center_elev, float pw, vec4 ring) {
    vec2 ts = u_elevation_texel;
    float east_diff = (elevation_at(uv + vec2(ts.x, 0.0), dx, dy, pw, ring).r
                     - elevation_at(uv - vec2(ts.x, 0.0), dx, dy, pw, ring).r) * 0.5;
    float north_diff = (elevation_at(uv - vec2(0.0, ts.y), dx, dy, pw, ring).r
                      - elevation_at(uv + vec2(0.0, ts.y), dx, dy, pw, ring).r) * 0.5;
    float height_to_radius = 6000.0 / 6371000.0;
    float east_dist = max(2.0 * PI * ts.x * max(cos(lat), 0.12), 0.000001);
    float north_dist = max(radians(170.0) * ts.y, 0.000001);
    vec3 east = vec3(cos(lon), 0.0, -sin(lon));
    vec3 north = vec3(-sin(lon) * sin(lat), cos(lat), -cos(lon) * sin(lat));
    return normalize(base - TERRAIN_STRENGTH * (east * (east_diff * height_to_radius / east_dist)
                                              + north * (north_diff * height_to_radius / north_dist)));
}

// Halo pass: front point of the expanded shell, clipped at the globe silhouette.
vec3 halo(vec3 o, vec3 dir) {
    float rs = HALO_SHELL;
    float b = dot(o, dir);
    float disc = b * b - (dot(o, o) - rs * rs);
    if (u_atmosphere < 0.5 || disc < 0.0) {
        return vec3(0.0);
    }
    vec3 hn = normalize(o + dir * (-b - sqrt(disc)));
    float facing = dot(hn, u_center);
    if (facing <= 0.0 || facing >= HALO_INNER) {
        return vec3(0.0);
    }
    float depth = clamp(facing / HALO_INNER, 0.0, 1.0);
    float density = depth * (2.0 - depth);
    float elev = dot(hn, u_sun);
    float daylight = smoothstep(-0.14, 0.28, elev);
    float twilight = 1.0 - smoothstep(0.06, 0.30, abs(elev));
    vec3 colour = mix(vec3(0.035, 0.075, 0.18), vec3(0.16, 0.43, 0.92), daylight);
    colour = mix(colour, vec3(1.0, 0.34, 0.075), twilight * 0.58);
    return colour * density * (0.010 + daylight * 0.070 + twilight * 0.055);
}

void main() {
    if (u_compare > 0.5) {
        fragColor = vec4(0.0);
        return;
    }

    vec4 pa = u_inverse * vec4(v_ndc, -1.0, 1.0);
    vec4 pb = u_inverse * vec4(v_ndc, 1.0, 1.0);
    vec3 o = pa.xyz / pa.w;
    vec3 d = normalize(pb.xyz / pb.w - o);

    bool flat_on = u_globe < 0.5;
    vec3 p;
    vec3 n;
    float lat;
    float lon;
    vec3 glow = vec3(0.0);

    if (!flat_on) {
        float b = dot(o, d);
        float disc = b * b - dot(o, o) + 1.0;
        glow = halo(o, d);
        if (disc < 0.0) {
            // Miss: the halo is additive over space (alpha 0).
            fragColor = vec4(glow, 0.0);
            return;
        }
        p = o + d * (-b - sqrt(disc));
        n = normalize(p);
        lat = asin(clamp(n.y, -1.0, 1.0));
        float cos_c = u_center.z / max(length(vec2(u_center.x, u_center.z)), 1e-6);
        float sin_c = u_center.x / max(length(vec2(u_center.x, u_center.z)), 1e-6);
        float center_lon = atan(u_center.x, u_center.z);
        // Longitude relative to the view centre: continuous across the antimeridian.
        lon = center_lon + atan(n.x * cos_c - n.z * sin_c, n.z * cos_c + n.x * sin_c);
    } else {
        if (abs(d.z) < 1e-7) {
            fragColor = vec4(0.0);
            return;
        }
        p = o + d * (-o.z / d.z);
        if (p.y < 0.0 || p.y > 1.0) {
            fragColor = vec4(0.0);
            return;
        }
        lon = (p.x - 0.5) * 2.0 * PI;
        lat = 2.0 * atan(exp(PI * (1.0 - 2.0 * p.y))) - PI * 0.5;
        n = vec3(sin(lon) * cos(lat), sin(lat), cos(lon) * cos(lat));
    }

    float fade_start = flat_on ? 3.5 : MATERIAL_FADE_START;
    float fade_end = flat_on ? 5.5 : MATERIAL_FADE_END;
    vec3 v_eye = flat_on ? normalize(u_center) : normalize(o - p);

    float zoom = u_zoom;
    float detail = u_detail;
    float dark = u_dark;
    float cycle = u_cycle;
    float style = 1.0;
    float muted = 0.0;
    vec3 sun = normalize(u_sun);

    float solar = dot(n, sun);
    float sin_elev = mix(1.0, solar, cycle);
    float lut_jitter = (hash13(n * 8192.0 + vec3(11.3)) - 0.5) * (3.0 / 256.0);
    float lut_u = clamp((sin_elev + 0.35) / 0.70 + lut_jitter, 0.0, 1.0);
    vec4 sky = texture(t_lut, vec2(lut_u, 0.5)) * cycle;
    float golden = smootherstep(-0.055, 0.015, sin_elev) * (1.0 - smootherstep(0.13, 0.30, sin_elev));
    float golden_alpha = golden * mix(0.018, 0.032, dark);
    // Gamma-space adaptation: no srgb2lin on the golden tint.
    sky.rgb += vec3(0.96, 0.48, 0.18) * golden_alpha;
    sky.a = clamp(sky.a + golden_alpha * (1.0 - sky.a), 0.0, 1.0);

    vec2 uv = vec2(lon / (2.0 * PI) + 0.5, clamp((radians(85.0) - lat) / radians(170.0), 0.0, 1.0));
    float pw = polar_weight(uv.y);
    vec4 ring_lights = vec4(0.0);
    vec4 ring_elevation = vec4(0.0);
    vec4 ring_material = vec4(0.0);
    if (pw > 0.0) {
        ring_lights = ring_mean(t_lights, uv.y);
        ring_elevation = ring_mean(t_elevation, uv.y);
        ring_material = ring_mean(t_material, uv.y);
    }
    vec2 dx = dFdx(uv);
    vec2 dy = dFdy(uv);
    vec2 uv_width = fwidth(uv);

    vec4 city = lights_grad(uv, dx, dy, pw, ring_lights);
    float land_mask = city.a;

    // Water PBR (far field of the game's flWater): Fresnel sky reflection plus a
    // Beckmann glint lobe whose variance covers the unresolved wave spectrum.
    float spec = 0.0;
    float fres = 0.0;
    vec3 refl = vec3(0.0);
    vec3 glint = vec3(0.0);
    if (u_material > 0.5) {
        float water = 1.0 - land_mask;
        vec3 v = v_eye;
        float wind_raw = value_noise3(n * 6.0) * 0.65 + value_noise3(n * 13.8 + 7.0) * 0.35;
        float lost = 0.0430 * 0.1318;
        float s2 = mix(0.007, 0.015, smoothstep(0.1, 0.9, wind_raw)) + lost * mix(0.6, 1.8, wind_raw);
        float n_dot_v = flat_on ? 1.0 : max(dot(n, v), 0.0);
        float elevation_deg = degrees(asin(clamp(sin_elev, -1.0, 1.0)));
        float day = smoothstep(-2.0, 10.0, elevation_deg);
        float sky_day = clamp(elevation_deg * 0.05 + 0.2, 0.0, 1.0);
        vec3 sky_c = mix(vec3(0.20, 0.25, 0.34), vec3(0.47, 0.62, 0.80), sky_day);
        vec3 hor_c = mix(vec3(0.30, 0.31, 0.36), vec3(0.68, 0.74, 0.80), sky_day);
        vec3 r = reflect(-v, n);
        refl = mix(hor_c, sky_c, flat_on ? 1.0 : clamp(dot(r, n) * 2.0, 0.0, 1.0)) * mix(0.10, 0.62, day);
        fres = (0.02 + 0.98 * pow(1.0 - n_dot_v, 5.0)) * water;
        vec3 h = normalize(v + sun);
        float ch = max(dot(n, h), 1e-3);
        float ch2 = ch * ch;
        float dd = exp((ch2 - 1.0) / (ch2 * s2)) / (PI * s2 * ch2 * ch2);
        float fh = 0.02 + 0.98 * pow(1.0 - max(dot(v, h), 0.0), 5.0);
        float lobe = fh * dd / (4.0 * max(n_dot_v, 0.25)) * smoothstep(0.0, 0.06, solar);
        float low_sun = 1.0 - smoothstep(0.12, 0.35, solar);
        float e = mix(lobe * 1.4, sqrt(lobe) * 0.8, low_sun);
        spec = (e / (1.0 + e)) * 0.75 * day * water;
        glint = mix(vec3(1.0, 0.64, 0.34), vec3(1.0, 0.90, 0.72), smoothstep(0.05, 0.45, solar));
    }

    float dither = (hash12(gl_FragCoord.xy) - 0.5) / 255.0 * cycle;

    // Material, terrain, snow and lights.
    float atlas_smooth = smootherstep(4.0, 5.5, detail);
    bool frozen_visible = u_snow > 0.5 && zoom < 10.0;
    bool reconstruct_coast = frozen_visible && detail > 2.0;
    vec4 smooth_city = city;
    if (reconstruct_coast || (atlas_smooth > 0.0 && detail < 8.5)) {
        smooth_city = lights_smooth(uv, dx, dy, pw, ring_lights);
    }
    float frozen_land = land_mask;
    if (reconstruct_coast) {
        vec2 footprint = uv_width / u_lights_texel;
        float coast_mix = 1.0 - smootherstep(0.5, 1.0, min(footprint.x, footprint.y));
        float coast_field = mix(land_mask, smooth_city.a, coast_mix);
        float half_w = max(fwidth(coast_field) * 0.65, 0.001);
        frozen_land = mix(land_mask, smoothstep(0.5 - half_w, 0.5 + half_w, coast_field), coast_mix);
    }
    if (sin_elev < 0.05) {
        city = mix(city, smooth_city, atlas_smooth);
    }

    float elev = 0.0;
    bool elev_sampled = false;
    float material_alpha = 0.0;
    vec3 material_rgb = vec3(0.0);
    float terrain_alpha = 0.0;
    vec3 terrain_rgb = vec3(0.0);
    vec3 t_normal = n;
    bool t_normal_ready = false;
    float t_relative = 0.0;
    float integrated_lod = 1.0 - smootherstep(fade_start, fade_end, detail);
    float integrated_day = mix(0.20, 1.0, smootherstep(-0.16, 0.02, sin_elev));
    bool material_lod = u_material > 0.5 && detail < fade_end;

    // Stable snow: climatology peak/duration on the ±90° mapping, gated by vector
    // glacier / ice-sheet support. Sampled before the material so its terrain relief
    // can reuse the elevation normal past the material's fade_end.
    vec2 clim_uv = snow_clim_uv(lat, lon);
    vec2 clim_dx = vec2(dx.x, dx.y * (170.0 / 180.0));
    vec2 clim_dy = vec2(dy.x, dy.y * (170.0 / 180.0));
    vec4 snow_climate = vec4(0.0);
    float snow_support = 0.0;
    float snow_stable = 0.0;
    if (u_snow > 0.5 && land_mask > 0.001) {
        snow_climate = textureGrad(t_snow, clim_uv, clim_dx, clim_dy);
        float peak = clamp((snow_climate.a - 0.25) / 0.75, 0.0, 1.0);
        float months = clamp(snow_climate.b / max(peak, 0.002), 0.0, 1.0) * 12.0;
        snow_support = textureGrad(t_snow_support, clim_uv, clim_dx, clim_dy).r;
        snow_stable = smoothstep(SNOW_PEAK_LO, SNOW_PEAK_HI, peak)
                    * smoothstep(SNOW_MONTHS_LO, SNOW_MONTHS_HI, months)
                    * snow_support;
    }

    bool needs_terrain = land_mask > 0.01 && (material_lod || (snow_stable > 0.001 && detail < 8.8));
    if (needs_terrain) {
        elev = elevation_at(uv, dx, dy, pw, ring_elevation).r;
        elev_sampled = true;
        t_normal = terrain_normal(n, uv, dx, dy, lat, lon, elev, pw, ring_elevation);
        t_normal_ready = true;
        t_relative = dot(t_normal, sun) - solar;
    }

    if (material_lod && t_normal_ready) {
        float visibility = mix(0.18, 1.0, smootherstep(-0.12, 0.04, sin_elev));
        float lum = clamp(t_relative * 1.32, -0.18, 0.14) * visibility;
        vec3 highlight = mix(vec3(0.90, 0.92, 0.94), vec3(0.54, 0.59, 0.64), dark);
        terrain_rgb = mix(vec3(0.002, 0.006, 0.012), highlight, step(0.0, lum));
        terrain_alpha = land_mask * integrated_lod * integrated_day * abs(lum) * mix(1.0, 0.55, muted);
    }

    if (material_lod) {
        if (!elev_sampled) {
            elev = elevation_at(uv, dx, dy, pw, ring_elevation).r;
            elev_sampled = true;
        }
        vec4 field = mix(textureGrad(t_material, uv, dx, dy), ring_material, pw);
        float confidence = max(max(field.r, field.g), abs(field.b - 0.5) * 2.0);
        float land_opacity = mix(0.46, 0.56, style);
        float lift = 1.0 - smootherstep(ORBIT_LIFT_START, ORBIT_LIFT_END, zoom);
        land_opacity = mix(land_opacity, mix(mix(0.30, 0.38, style), ORBIT_LIFT_OPACITY, lift), dark);
        float land_a = land_mask * integrated_lod * integrated_day * land_opacity;
        land_a *= mix(0.58, 1.0, smootherstep(0.04, 0.72, confidence));
        float ocean_opacity = mix(0.30, 0.38, style);
        ocean_opacity = mix(ocean_opacity, mix(0.24, 0.33, style), dark);
        float ocean_a = (1.0 - land_mask) * integrated_lod * integrated_day * ocean_opacity;
        material_alpha = (land_a + ocean_a) * mix(1.0, 0.55, muted);
        material_rgb = mix(ocean_colour(1.0 - field.a, style, dark, muted),
                           material_colour(field.rgb, lat, elev, style, dark, muted, lift), land_mask);
    }

    // Orbit relief: north-west map hillshade, not the sun (a high sun flattens relief).
    float relief_shade = 0.0;
    if (t_normal_ready && u_material > 0.5) {
        vec3 east = vec3(cos(lon), 0.0, -sin(lon));
        vec3 hill_light = normalize(n * 0.70 + (cross(n, east) - east) * 0.50);
        float hill = dot(t_normal, hill_light) - dot(n, hill_light);
        float shade = clamp(hill * ORBIT_RELIEF_GAIN, -0.48, 0.26) * smootherstep(-0.02, 0.12, sin_elev);
        relief_shade = shade * land_mask * integrated_lod;
    }

    // Arterial-only local data cannot fill a street grid at z8+, so Round 03
    // keeps a floor of the unresolved atlas instead of fading it to zero:
    // the original's full tile pass would have drawn the missing streets.
    float handoff = max(1.0 - smootherstep(5.25, 8.5, detail), u_atlas_floor);
    float emission = 0.0;
    vec3 light_rgb = vec3(0.0);
    float city_glow = 0.0;
    if (handoff > 0.0) {
        vec4 bloom = lights_grad(uv, dx * 8.0, dy * 8.0, pw, ring_lights);
        float bloom_dark = 1.0 - smoothstep(-0.21, -0.02, sin_elev);
        city_glow = pow(bloom.r, 0.8) * bloom_dark * 0.10 * u_lights * handoff;
        float stagger = (city.b - 0.5) * 0.14;
        float darkness = 1.0 - smoothstep(-0.21 + stagger, -0.02 + stagger, sin_elev);
        if (darkness > 0.0 && city.r > 0.0 && city.a > 0.0) {
            float hour = fract(u_time_days + lon / (2.0 * PI)) * 24.0;
            float evening_hour = hour < 17.0 ? hour + 24.0 : hour;
            float evening = smoothstep(17.0, 20.0, evening_hour) * (1.0 - smoothstep(23.0, 26.0, evening_hour));
            float night = 1.0 - smoothstep(2.0, 5.0, hour);
            float activity = clamp(0.30 + 0.70 * max(evening, 0.55 * clamp(night, 0.0, 1.0)), 0.0, 1.0);
            float metro = 1.0 - smoothstep(0.0, 1.0, city.g);
            float twinkle_amp = mix(0.025, 0.08, city.g);
            float seed = fract(city.b * 43.0 + city.g * 17.0);
            float rate = mix(0.125, 0.0625, step(0.5, fract(seed * 7.0)));
            float phase = fract(u_twinkle * rate + seed);
            float tri = 1.0 - abs(phase * 2.0 - 1.0);
            float signal = tri * tri * (3.0 - 2.0 * tri);
            float tw = 1.0 + (signal - 0.5) * twinkle_amp;
            float density = pow(city.r, 0.45) * city.a;
            emission = density * darkness * activity * tw * mix(0.28, 0.5, dark) * u_lights * handoff;
            vec3 kind = mix(vec3(1.0, 0.63, 0.31), vec3(1.0, 0.86, 0.56), metro);
            light_rgb = mix(kind, vec3(1.0, 0.94, 0.84), smoothstep(0.55, 0.95, city.r));
            // 0 keeps the atlas fully on; 1 is the original handover. The app
            // supplies the zoom/availability gate so missing roads never dim
            // the atlas before the network is actually drawn. The mid pass may
            // dim earlier, but never deeper than the near network's 0.45.
            float atlas_dim = max(MID_LIGHTS_UNDER_ROADS * u_mid_takeover,
                                  (1.0 - LIGHTS_UNDER_ROADS) * u_roads_takeover);
            emission *= 1.0 - atlas_dim;
        }
    }

    // Stable/perennial snow only. Seasonal climatology windows (the game's expanding
    // snow line and sea ice) are intentionally not evaluated. The layer is independent
    // of the material fade_end: it stays until its own 8.5..10 zoom fade, so the
    // same ice sheet hands over continuously from the atlas to the vector tiles.
    float snow_cover = 0.0;
    float snow_relief = 0.0;
    if (snow_stable > 0.001 && land_mask > 0.001) {
        if (t_normal_ready) {
            float relief_lod = smootherstep(2.4, 4.2, zoom) * (1.0 - smootherstep(6.6, 8.8, detail));
            if (relief_lod > 0.001) {
                float snow_relative = t_relative;
                if (cycle < 0.5) {
                    vec3 east = vec3(cos(lon), 0.0, -sin(lon));
                    vec3 north = cross(n, east);
                    vec3 snow_light = normalize(n * 0.82 + (north - east) * 0.40);
                    snow_relative = dot(t_normal, snow_light) - dot(n, snow_light);
                }
                float relief_day = smootherstep(-0.06, 0.10, sin_elev);
                float relief_strength = mix(1.9, 1.4, smootherstep(4.8, 6.8, detail));
                snow_relief = clamp(snow_relative * relief_strength, -0.30, 0.24)
                            * relief_lod * relief_day * land_mask;
            }
        }
        float day_vis = smoothstep(-0.10, -0.01, sin_elev);
        float zoom_fade = 1.0 - smootherstep(8.5, 10.0, zoom);
        float day_strength = mix(0.88, 0.76, dark);
        snow_cover = snow_stable * frozen_land * mix(0.12, day_strength, day_vis) * zoom_fade;
    }

    float snow_day = smoothstep(-0.12, -0.03, sin_elev);
    // Display-space snow colours (the source's dark branch linearises these; see header).
    vec3 day_snow = mix(vec3(0.95, 0.965, 0.98), vec3(0.94, 0.95, 0.96), dark);
    float snow_shadow = clamp(-snow_relief * 2.2, 0.0, 0.65);
    float snow_highlight = clamp(snow_relief * 1.8, 0.0, 0.50);
    day_snow = mix(day_snow, mix(vec3(0.66, 0.75, 0.84), vec3(0.72, 0.79, 0.86), dark), snow_shadow * 0.72);
    day_snow = mix(day_snow, mix(vec3(0.995, 0.985, 0.955), vec3(0.98, 0.96, 0.92), dark), snow_highlight * 0.55);
    vec3 snow_rgb = mix(vec3(0.52, 0.60, 0.82), day_snow, snow_day);

    vec3 surface = material_rgb * material_alpha + terrain_rgb * terrain_alpha * (1.0 - material_alpha);
    surface *= mix(vec3(1.0), vec3(1.055, 1.012, 0.955), golden);
    float surface_alpha = material_alpha + terrain_alpha * (1.0 - material_alpha);
    // The sea's sky reflection sits on the surface, under the night LUT.
    surface = refl * fres + surface * (1.0 - fres);
    surface_alpha = fres + surface_alpha * (1.0 - fres);
    vec3 base_rgb = sky.rgb + surface * (1.0 - sky.a);
    float base_alpha = sky.a + surface_alpha * (1.0 - sky.a);
    float frozen = snow_cover;
    spec *= 1.0 - frozen;
    vec3 lit_rgb = base_rgb * (1.0 - frozen) + snow_rgb * snow_cover;
    float lit_alpha = base_alpha * (1.0 - frozen) + frozen;

    // Orbital land shading as a multiplier on everything under the overlay:
    // premultiplied (rgb * L, 1 - (1 - a) * L) also scales the tiles beneath.
    vec3 v = v_eye;
    float mu = flat_on ? 1.0 : max(dot(n, v), 0.05);
    float orbit = 1.0 - smootherstep(8.5, 10.0, zoom);
    float light_mul = 1.0;
    if (cycle > 0.5) {
        light_mul = mix(1.0, mix(0.82, 1.0, smoothstep(0.0, 0.26, solar)), orbit);
    }
    float haze_w = u_atmosphere * (1.0 - smootherstep(4.5, 7.0, zoom));
    float air = 1.0 / mu - 1.0;
    light_mul *= 1.0 + relief_shade;
    light_mul = min(light_mul, 1.0 / max(1.0 - lit_alpha, 1e-3));
    lit_rgb *= light_mul;
    lit_alpha = 1.0 - (1.0 - lit_alpha) * light_mul;
    float air_day = smoothstep(-0.14, 0.28, solar);
    float air_twilight = 1.0 - smoothstep(0.06, 0.30, abs(solar));
    vec3 air_c = mix(vec3(0.16, 0.38, 0.85), vec3(1.0, 0.42, 0.14), air_twilight * 0.45);
    lit_rgb += air_c * (1.0 - exp(-0.07 * air)) * mix(0.02, 0.55, air_day) * haze_w;

    // Snow glint: broad Beckmann lobe, a sheen rather than a spot.
    float frost_spec = 0.0;
    if (cycle > 0.5 && frozen > 0.0) {
        vec3 h = normalize(v + sun);
        float ch = max(dot(n, h), 1e-3);
        float ch2 = ch * ch;
        float s2f = 0.12;
        float dd = exp((ch2 - 1.0) / (ch2 * s2f)) / (PI * s2f * ch2 * ch2);
        float fh = 0.03 + 0.97 * pow(1.0 - max(dot(v, h), 0.0), 5.0);
        float e = fh * dd / (4.0 * max(dot(n, v), 0.25)) * smoothstep(0.0, 0.08, solar);
        frost_spec = (e / (1.0 + e)) * 0.35 * frozen * orbit;
    }

    vec3 glow_rgb = vec3(1.0, 0.70, 0.40) * city_glow;
    vec3 rgb = lit_rgb + light_rgb * emission + glow_rgb + glint * spec + vec3(frost_spec) + dither;
    float alpha = lit_alpha + emission + city_glow + spec + frost_spec + dither;

    if (u_debug > 0.5) {
        if (u_debug < 1.5) fragColor = vec4(sky.rgb * sky.a, 1.0);
        else if (u_debug < 2.5) fragColor = vec4(material_rgb, 1.0);
        else if (u_debug < 3.5) fragColor = vec4(vec3(snow_cover), 1.0);
        else if (u_debug < 4.5) fragColor = vec4(lit_rgb, 1.0);
        else if (u_debug < 5.5) fragColor = vec4(vec3(material_alpha), 1.0);
        else if (u_debug < 6.5) fragColor = vec4(vec3(sin_elev * 0.5 + 0.5), 1.0);
        // Raw snow inputs: climatology A (peak), B (duration), stable gate, vector support.
        else fragColor = vec4(snow_climate.a, snow_climate.b, snow_stable, snow_support);
        return;
    }
    float a = clamp(alpha, 0.0, 1.0);
    fragColor = vec4(rgb + glow * (1.0 - a), a);
}
