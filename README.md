# `pbuf-setup` GitHub Action README

## Overview
The `pbuf-setup` GitHub Action is designed to install `pbuf-cli`, a command-line interface tool, for use in other jobs within a GitHub Actions workflow. 

## Requirements
- GitHub Actions runner with either Linux or Darwin operating system.
- Architecture must be either AMD64 or ARM64.

## Features
- **Version Control**: Specify the desired version of `pbuf-cli` to be installed.
- **Platform Compatibility Check**: Ensures compatibility with Linux and Darwin operating systems and AMD64 or ARM64 architectures.
- **Automatic Download and Installation**: Downloads and installs `pbuf-cli` automatically to the runner's environment.
- **Token Auth Support**: Supports usage of a `pbuf_token` for operations requiring authentication with the PBUF registry.

## Inputs
- **`version`**: The version of the CLI to install. Default is 'v0.3.2'. This input is optional.
- **`pbuf_token`**: The API token for authenticating with the PBUF registry. This input is optional.

## Usage
To use this action, include it in your workflow `.yml` file with the necessary inputs. Below is a sample configuration:

```yml
steps:
- name: Install pbuf-cli
  uses: pbufio/pbuf-setup@v1.0.0
  with:
    version: 'v0.3.2' # Optional, specify the desired version
    pbuf_token: ${{ secrets.PBUF_TOKEN }} # Optional, your PBUF API token
```