// Reads a .hday file written by hoboken-sim/scripts/export_unreal.mjs and says where everyone
// is at any clock time. Plain C++17 with no Unreal types, so it is compiled and checked against
// the JavaScript engine outside Unreal (hoboken-sim/tests/unreal.test.mjs).
#pragma once

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace hoboken {

struct Material {
  float r, g, b, a;  // sRGB
};

struct Mesh {
  uint32_t material = 0;
  std::vector<float> positions;  // x, y, z in centimetres: X north, Y east, Z up
  std::vector<float> normals;
  std::vector<uint32_t> indices;
};

struct Agent {
  uint8_t group = 0;  // Residents, Commuters or Visitors
  uint8_t flags = 0;  // 1 = has a dog
  uint32_t legStart = 0;
  uint32_t legCount = 0;
};

struct Leg {
  uint8_t kind = 0;  // Stay, Trip or Away
  uint8_t mode = 0;  // Walk, Bike or Car
  uint8_t flags = 0; // WithDog | Outdoors
  uint8_t act = 0;
  float t0 = 0, t1 = 0;
  int32_t route = -1;
  float x = 0, y = 0;
};

struct Route {
  uint32_t start = 0;
  uint32_t count = 0;
  float length = 0;
};

enum : uint8_t { Stay = 0, Trip = 1, Away = 2 };
enum : uint8_t { Walk = 0, Bike = 1, Car = 2 };
enum : uint8_t { WithDog = 1, Outdoors = 2 };
enum : uint8_t { Residents = 0, Commuters = 1, Visitors = 2 };

/** Someone in view at a moment: on foot, cycling or driving, or out in a park or dog run. */
struct Figure {
  uint32_t agent;
  float x, y;  // centimetres
  float yaw;   // degrees, Unreal convention (0 = north, 90 = east)
  uint8_t group, mode, dog, moving;
};

class Day {
 public:
  uint32_t dayType = 0;  // 0 weekday, 1 Saturday
  float dayStart = 0, dayEnd = 0, sunrise = 0, sunset = 0;  // seconds after midnight
  std::vector<Material> materials;
  std::vector<Mesh> meshes;
  std::vector<Agent> agents;
  std::vector<Leg> legs;
  std::vector<Route> routes;
  std::vector<float> points;  // x, y pairs
  std::vector<float> along;   // distance along its route at each point

  bool load(const uint8_t* data, size_t size, std::string* error);

  /** Everyone in view at clock time t (seconds after midnight, dayStart..dayEnd). */
  const std::vector<Figure>& evaluate(float t);

 private:
  std::vector<Figure> figures_;
  std::vector<uint32_t> cursor_;
  float last_ = -1.0f;
};

namespace detail {

class Reader {
 public:
  Reader(const uint8_t* data, size_t size) : p_(data), n_(size) {}
  template <typename T>
  T get() {
    T v{};
    if (!ok_ || n_ - o_ < sizeof(T)) {
      ok_ = false;
      return v;
    }
    std::memcpy(&v, p_ + o_, sizeof(T));
    o_ += sizeof(T);
    return v;
  }
  template <typename T>
  void array(std::vector<T>& out, size_t count) {
    if (!ok_ || count > (n_ - o_) / sizeof(T)) {
      ok_ = false;
      return;
    }
    out.resize(count);
    if (count) std::memcpy(out.data(), p_ + o_, count * sizeof(T));
    o_ += count * sizeof(T);
  }
  bool ok() const { return ok_; }
  bool done() const { return o_ == n_; }

 private:
  const uint8_t* p_;
  size_t n_;
  size_t o_ = 0;
  bool ok_ = true;
};

inline bool fail(std::string* error, const char* why) {
  if (error) *error = why;
  return false;
}

}  // namespace detail

inline bool Day::load(const uint8_t* data, size_t size, std::string* error) {
  detail::Reader r(data, size);
  char magic[4];
  for (char& c : magic) c = r.get<char>();
  if (!r.ok() || std::memcmp(magic, "HDAY", 4) != 0) return detail::fail(error, "not a Hoboken day file (.hday)");
  if (r.get<uint32_t>() != 1) return detail::fail(error, "unsupported .hday version");
  dayType = r.get<uint32_t>();
  dayStart = r.get<float>();
  dayEnd = r.get<float>();
  sunrise = r.get<float>();
  sunset = r.get<float>();

  const uint32_t nMaterials = r.get<uint32_t>();
  if (nMaterials > 4096) return detail::fail(error, "too many materials");
  materials.resize(nMaterials);
  for (Material& m : materials) {
    m.r = r.get<float>();
    m.g = r.get<float>();
    m.b = r.get<float>();
    m.a = r.get<float>();
  }
  const uint32_t nMeshes = r.get<uint32_t>();
  if (nMeshes > 4096) return detail::fail(error, "too many meshes");
  meshes.assign(nMeshes, Mesh());
  for (Mesh& m : meshes) {
    m.material = r.get<uint32_t>();
    const uint32_t nv = r.get<uint32_t>();
    const uint32_t ni = r.get<uint32_t>();
    r.array(m.positions, size_t(nv) * 3);
    r.array(m.normals, size_t(nv) * 3);
    r.array(m.indices, ni);
    if (!r.ok()) return detail::fail(error, "truncated mesh");
    if (m.material >= nMaterials || ni % 3) return detail::fail(error, "bad mesh");
    for (uint32_t i : m.indices) {
      if (i >= nv) return detail::fail(error, "mesh index out of range");
    }
  }

  const uint32_t nAgents = r.get<uint32_t>();
  if (!r.ok() || nAgents > size / 12) return detail::fail(error, "bad people count");
  agents.resize(nAgents);
  for (Agent& a : agents) {
    a.group = r.get<uint8_t>();
    a.flags = r.get<uint8_t>();
    r.get<uint16_t>();
    a.legStart = r.get<uint32_t>();
    a.legCount = r.get<uint32_t>();
  }
  const uint32_t nLegs = r.get<uint32_t>();
  if (!r.ok() || nLegs > size / 24) return detail::fail(error, "bad leg count");
  legs.resize(nLegs);
  for (Leg& l : legs) {
    l.kind = r.get<uint8_t>();
    l.mode = r.get<uint8_t>();
    l.flags = r.get<uint8_t>();
    l.act = r.get<uint8_t>();
    l.t0 = r.get<float>();
    l.t1 = r.get<float>();
    l.route = r.get<int32_t>();
    l.x = r.get<float>();
    l.y = r.get<float>();
  }
  const uint32_t nRoutes = r.get<uint32_t>();
  if (!r.ok() || nRoutes > size / 8) return detail::fail(error, "bad route count");
  routes.resize(nRoutes);
  for (Route& rt : routes) {
    rt.start = r.get<uint32_t>();
    rt.count = r.get<uint32_t>();
  }
  const uint32_t nPoints = r.get<uint32_t>();
  r.array(points, size_t(nPoints) * 2);
  if (!r.ok()) return detail::fail(error, "truncated file");
  if (!r.done()) return detail::fail(error, "unexpected bytes at the end of the file");

  for (const Agent& a : agents) {
    if (uint64_t(a.legStart) + a.legCount > nLegs) return detail::fail(error, "person's legs out of range");
  }
  for (const Leg& l : legs) {
    if (l.route >= int32_t(nRoutes) || (l.kind == Trip && l.route < 0)) return detail::fail(error, "leg route out of range");
  }
  along.assign(nPoints, 0.0f);
  for (Route& rt : routes) {
    if (rt.count < 2 || uint64_t(rt.start) + rt.count > nPoints) return detail::fail(error, "route points out of range");
    float s = 0.0f;
    for (uint32_t i = rt.start + 1; i < rt.start + rt.count; i++) {
      s += std::hypot(points[2 * i] - points[2 * i - 2], points[2 * i + 1] - points[2 * i - 1]);
      along[i] = s;
    }
    rt.length = s;
  }
  cursor_.assign(nAgents, 0);
  for (uint32_t i = 0; i < nAgents; i++) cursor_[i] = agents[i].legStart;
  last_ = -1.0f;
  figures_.clear();
  return true;
}

inline const std::vector<Figure>& Day::evaluate(float t) {
  figures_.clear();
  const bool rewind = last_ < 0.0f || t < last_;
  last_ = t;
  for (uint32_t i = 0; i < agents.size(); i++) {
    const Agent& a = agents[i];
    if (!a.legCount) continue;
    uint32_t l = rewind ? a.legStart : cursor_[i];
    const uint32_t end = a.legStart + a.legCount - 1;
    while (l < end && t >= legs[l].t1) l++;
    cursor_[i] = l;
    const Leg& g = legs[l];
    if (t < g.t0 || t >= g.t1) continue;
    const uint8_t dog = (g.flags & WithDog) ? 1 : 0;
    if (g.kind == Trip) {
      const Route& rt = routes[g.route];
      const float span = g.t1 - g.t0;
      float f = span > 0.0f ? (t - g.t0) / span : 1.0f;
      f = f < 0.0f ? 0.0f : f > 1.0f ? 1.0f : f;
      const float s = f * rt.length;
      uint32_t lo = rt.start;
      uint32_t hi = rt.start + rt.count - 1;
      while (lo < hi - 1) {
        const uint32_t mid = (lo + hi) / 2;
        if (along[mid] <= s) lo = mid;
        else hi = mid;
      }
      const float seg = along[hi] - along[lo];
      const float u = seg > 0.0f ? (s - along[lo]) / seg : 0.0f;
      const float dx = points[2 * hi] - points[2 * lo];
      const float dy = points[2 * hi + 1] - points[2 * lo + 1];
      Figure fig{i, points[2 * lo] + dx * u, points[2 * lo + 1] + dy * u, 0.0f, a.group, g.mode, dog, 1};
      if (dx != 0.0f || dy != 0.0f) fig.yaw = std::atan2(dy, dx) * 57.2957795f;
      figures_.push_back(fig);
    } else if (g.kind == Stay && (g.flags & Outdoors)) {
      figures_.push_back(Figure{i, g.x, g.y, 0.0f, a.group, Walk, dog, 0});
    }
  }
  return figures_;
}

}  // namespace hoboken
