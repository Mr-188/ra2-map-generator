#include "ini.h"

#include <cctype>
#include <cstdlib>

namespace mg {

std::string IniFile::lower(const std::string& s)
{
    std::string out;
    out.reserve(s.size());
    for (char c : s)
        out.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    return out;
}

IniFile IniFile::parse(const std::uint8_t* data, std::size_t len)
{
    IniFile ini;
    if (!data || len == 0) return ini;

    std::string current;  // lowercase section name; empty = before any section
    bool haveSection = false;

    std::size_t pos = 0;
    while (pos <= len)
    {
        std::size_t nl = pos;
        while (nl < len && data[nl] != '\n') ++nl;
        std::string line(reinterpret_cast<const char*>(data + pos), nl - pos);
        pos = (nl >= len) ? len + 1 : nl + 1;

        // strip the CR and trailing blanks
        while (!line.empty() &&
               (line.back() == '\r' || line.back() == ' ' || line.back() == '\t'))
            line.pop_back();
        std::size_t start = 0;
        while (start < line.size() && (line[start] == ' ' || line[start] == '\t')) ++start;
        if (start) line.erase(0, start);
        if (line.empty() || line[0] == ';' || line[0] == '#') continue;

        if (line[0] == '[')
        {
            const std::size_t close = line.find(']');
            if (close == std::string::npos) continue;
            const std::string name = line.substr(1, close - 1);
            current = lower(name);
            haveSection = true;
            if (ini.sections_.find(current) == ini.sections_.end())
            {
                ini.sections_.emplace(current, std::vector<Entry>{});
                ini.sectionOrder_.push_back(name);
            }
            continue;
        }

        const std::size_t eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string key = line.substr(0, eq);
        std::string value = line.substr(eq + 1);
        while (!key.empty() && (key.back() == ' ' || key.back() == '\t')) key.pop_back();
        std::size_t vstart = 0;
        while (vstart < value.size() && (value[vstart] == ' ' || value[vstart] == '\t'))
            ++vstart;
        if (vstart) value.erase(0, vstart);
        if (key.empty()) continue;

        if (!haveSection)
        {
            // A key before any [section] belongs to an implicit "" section,
            // which is what the Windows API does too.
            current = "";
            haveSection = true;
            if (ini.sections_.find(current) == ini.sections_.end())
            {
                ini.sections_.emplace(current, std::vector<Entry>{});
                ini.sectionOrder_.push_back("");
            }
        }
        auto it = ini.sections_.find(current);
        if (it == ini.sections_.end())
        {
            it = ini.sections_.emplace(current, std::vector<Entry>{}).first;
            ini.sectionOrder_.push_back(current);
        }
        it->second.push_back(Entry{key, value});
    }
    return ini;
}

bool IniFile::hasSection(const std::string& section) const
{
    return sections_.find(lower(section)) != sections_.end();
}

bool IniFile::has(const std::string& section, const std::string& key) const
{
    return !getString(section, key, std::string(), nullptr).empty() ||
           (sections_.find(lower(section)) != sections_.end() &&
            [&] {
                const auto& v = sections_.at(lower(section));
                const std::string k = lower(key);
                for (const Entry& e : v)
                    if (lower(e.key) == k) return true;
                return false;
            }());
}

std::string IniFile::getString(const std::string& section, const std::string& key,
                               const std::string& def, bool* found) const
{
    if (found) *found = false;
    const auto it = sections_.find(lower(section));
    if (it == sections_.end()) return def;
    const std::string k = lower(key);
    for (const Entry& e : it->second)
    {
        if (lower(e.key) == k)
        {
            if (found) *found = true;
            return e.value;
        }
    }
    return def;
}

int IniFile::getInt(const std::string& section, const std::string& key, int def) const
{
    const std::string text = getString(section, key, std::string(), nullptr);
    if (text.empty()) return def;
    const char* p = text.c_str();
    while (*p == ' ' || *p == '\t') ++p;
    char* end = nullptr;
    const long v = std::strtol(p, &end, 10);
    if (end == p) return def;
    return static_cast<int>(v);
}

std::vector<std::string> IniFile::keyNames(const std::string& section) const
{
    std::vector<std::string> out;
    const auto it = sections_.find(lower(section));
    if (it == sections_.end()) return out;
    out.reserve(it->second.size());
    for (const Entry& e : it->second) out.push_back(e.key);
    return out;
}

}  // namespace mg
