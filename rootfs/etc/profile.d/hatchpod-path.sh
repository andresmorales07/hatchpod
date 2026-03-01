# Hatchpod user PATH additions for login shells.
# Sourced by /etc/profile for all login shells (interactive and non-interactive).

# npm global packages (set via: npm config -g set prefix ~/.npm-global)
export PATH="/home/hatchpod/.npm-global/bin:$PATH"

# .NET global tools (dotnet tool install -g)
export PATH="$PATH:/home/hatchpod/.dotnet/tools"
