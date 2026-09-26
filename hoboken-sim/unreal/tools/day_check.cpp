// Command-line check of HobokenDay.h outside Unreal, used by hoboken-sim/tests/unreal.test.mjs:
//   day_check <file.hday> <seconds> [<seconds> ...]
// prints the file's counts, then for each time the people in view, one per line:
//   agent x y yaw group mode dog moving
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "../HobokenSim/Source/HobokenSim/Public/HobokenDay.h"

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: day_check <file.hday> [seconds...]\n");
    return 2;
  }
  std::ifstream in(argv[1], std::ios::binary);
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  hoboken::Day day;
  std::string error;
  if (!day.load(bytes.data(), bytes.size(), &error)) {
    std::fprintf(stderr, "load failed: %s\n", error.c_str());
    return 1;
  }
  size_t tris = 0;
  for (const auto& m : day.meshes) tris += m.indices.size() / 3;
  std::printf("day %u start %.0f end %.0f sunrise %.0f sunset %.0f materials %zu meshes %zu triangles %zu people %zu legs %zu routes %zu points %zu\n",
              day.dayType, day.dayStart, day.dayEnd, day.sunrise, day.sunset, day.materials.size(), day.meshes.size(), tris,
              day.agents.size(), day.legs.size(), day.routes.size(), day.points.size() / 2);
  for (int k = 2; k < argc; k++) {
    const float t = std::strtof(argv[k], nullptr);
    const auto& figures = day.evaluate(t);
    std::printf("t %s %zu\n", argv[k], figures.size());
    for (const auto& f : figures) {
      std::printf("%u %.2f %.2f %.1f %u %u %u %u\n", f.agent, f.x, f.y, f.yaw, f.group, f.mode, f.dog, f.moving);
    }
  }
  return 0;
}
