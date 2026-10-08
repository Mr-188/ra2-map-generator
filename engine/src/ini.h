// A small INI reader with Windows' GetPrivateProfile* semantics.
//
// Both the extractor and the Win32 shim need this: the extractor reads the
// theater INI out of a MIX to learn which TMP files a theater's tile sets are
// built from, and the shim backs the reference implementation's
// GetPrivateProfileIntA/StringA/SectionNamesA calls with it.
//
// Semantics reproduced from the Windows API, because the reference code depends
// on them:
//   * section and key lookup are CASE-INSENSITIVE
//   * values are trimmed of leading and trailing whitespace
//   * a line whose first non-blank character is ';' is a comment
//   * a key with no '=' is ignored
//   * the key list of a section preserves file order (the retail INIs rely on it)
#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace mg {

class IniFile
{
public:
    static IniFile parse(const std::uint8_t* data, std::size_t len);
    static IniFile parse(const std::vector<std::uint8_t>& bytes)
    {
        return parse(bytes.data(), bytes.size());
    }

    bool hasSection(const std::string& section) const;
    bool has(const std::string& section, const std::string& key) const;

    // Empty string when absent; *found tells the two apart.
    std::string getString(const std::string& section, const std::string& key,
                          const std::string& def = "", bool* found = nullptr) const;
    // Windows' GetPrivateProfileIntA: leading sign, stops at the first
    // non-digit, and returns the default only when the key is absent or the
    // text holds no digits at all.
    int getInt(const std::string& section, const std::string& key, int def = 0) const;

    std::vector<std::string> sectionNames() const { return sectionOrder_; }
    std::vector<std::string> keyNames(const std::string& section) const;

    bool empty() const { return sectionOrder_.empty(); }

private:
    struct Entry
    {
        std::string key;    // original spelling
        std::string value;
    };
    static std::string lower(const std::string& s);

    std::vector<std::string> sectionOrder_;                       // original spelling
    std::map<std::string, std::vector<Entry>> sections_;          // keyed lowercase
};

}  // namespace mg
